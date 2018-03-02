const path = require('path')
const fs = require('fs')
const os = require('os')
const yn = require('yn')
const tmp = require('tmp')
tmp.setGracefulCleanup() // delete tmp files even on uncaught exception

const _ = require('lodash')
const co = require('co')
const promisify = require('pify')
// const YAML = require('js-yaml')
const promptly = require('promptly')
const prompt = question => promptly.prompt(logger.color.question(question))
const pfs = promisify(fs)
const AWS = require('aws-sdk')
const shelljs = require('shelljs')
const mkdirp = promisify(require('mkdirp'))
const ModelsPack = require('@tradle/models-pack')
const CustomErrors = require('./errors')
const validate = require('./validate')
const utils = require('./utils')
const logger = require('./logger')
const { debug, prettify, isValidProjectPath, toEnvFile, confirmOrAbort } = utils
const AWS_CONF_PATH = `${os.homedir()}/.aws/config`
const getFileNameForItem = item => `${item.id}.json`
const read = file => fs.readFileSync(file, { encoding: 'utf8' })
const maybeRead = file => {
  if (fs.existsSync(file)) return read(file)
}

const readJSON = file => JSON.parse(read(file))
const maybeReadJSON = file => {
  const result = maybeRead(file)
  if (result) return JSON.parse(result)
}

const write = (file, data) => fs.writeFileSync(file, prettify(data))
const pwrite = (file, data) => pfs.writeFile(file, prettify(data))
const exists = file => fs.existsSync(file)
const getLongFunctionName = ({ stackName, functionName }) => {
  // in case it's already expanded
  if (functionName.lastIndexOf(stackName) === 0) return functionName

  return `${stackName}-${functionName}`
}

const readDirOfJSONs = dir => {
  return fs.readdirSync(dir)
    .map(file => require(path.resolve(dir, file)))
}

const normalizeError = err => {
  if (err instanceof Error) return err

  return new Error(JSON.stringify(err))
}

const DEPLOYABLES = [
  'bot',
  'style',
  'models',
  'terms'
]

const getDeployables = opts => _.pick(opts, DEPLOYABLES)
const getDeployablesKeys = opts => Object.keys(getDeployables(opts))
const DEPLOY_ALL_OPTS = DEPLOYABLES.reduce((obj, prop) => {
  obj[prop] = true
  return obj
}, {})

const getOptsOnly = opts => _.omit(opts, 'args')
const normalizeDeployOpts = (opts, command='deploy') => {
  if (opts.args.length) {
    throw new CustomErrors.InvalidInput(`unknown arguments: ${opts.args.join(' ')}`)
  }

  const all = opts.all || !_.size(getDeployables(opts))
  if (all) {
    return _.extend({}, DEPLOY_ALL_OPTS, opts)
  }

  if (!_.size(getDeployables(opts))) {
    throw new CustomErrors.InvalidInput(`you didn't indicate anything to ${command}!`)
  }

  return opts
}

const functions = {
  setconf: 'setconf',
  cli: 'cli',
  importDataUtils: 'import_data_utils'
}

const paths = {
  conf: './conf',
  bot: './conf/bot.json',
  style: './conf/style.json',
  terms: './conf/terms-and-conditions.md',
  models: './models',
  lenses: './lenses'
}

read.bot = () => maybeReadJSON(paths.bot)
read.style = () => maybeReadJSON(paths.style)
read.models = () => readDirOfJSONs(paths.models)
read.lenses = () => readDirOfJSONs(paths.lenses)
read.terms = () => maybeRead(paths.terms)

function Conf (opts) {
  if (!(this instanceof Conf)) {
    return new Conf(opts)
  }

  const { lambda, profile, stackName, local, remote, project, nodeFlags={} } = opts
  if (!lambda) {
    throw new CustomErrors.InvalidInput('expected "lambda"')
  }

  if (local && remote) {
    throw new CustomErrors.InvalidInput('expected "local" or "remote" but not both')
  }

  this.profile = profile
  this.stackName = stackName
  this.lambda = lambda
  this.local = local
  this.remote = remote
  this.project = project
  if (local) {
    if (!project) {
      throw new CustomErrors.InvalidInput('expected "project", the path to your local serverless project')
    }

    if (!isValidProjectPath(project)) {
      throw new CustomErrors.InvalidInput('expected "project" to point to serverless project dir')
    }
  }

  if (!nodeFlags.inspect && (nodeFlags.debug || nodeFlags['debug-brk'])) {
    nodeFlags.inspect = true
  }

  this.nodeFlags = nodeFlags
  let aws
  Object.defineProperty(this, 'aws', {
    set (value) {
      aws = value
    },
    get () {
      if (!aws) {
        aws = this._getAWSClient()
      }

      return aws
    }
  })
}

Conf.prototype._ensureStackName = function () {
  if (!this.stackName) {
    throw new CustomErrors.InvalidInput('expected "stackName"')
  }
}

Conf.prototype.deploy = co.wrap(function* (opts) {
  const items = this.getDeployItems(opts)
  logger.info('deploying: ', getDeployablesKeys(items).join(', '))
  if (opts.dryRun) return logger.info('dry run, not executing')

  const { error, result } = yield this.invoke({
    functionName: functions.setconf,
    arg: items
  })

  if (error) throw error

  return result
})

Conf.prototype.invoke = co.wrap(function* (opts) {
  const { functionName, arg, local=this.local } = opts
  let result
  try {
    const promise = local ? this._invokeLocal(opts) : this._invoke(opts)
    result = yield promise
  } catch (error) {
    return { error }
  }

  return { result }
})

Conf.prototype.invokeAndReturn = co.wrap(function* (opts) {
  const { error, result } = yield this.invoke(opts)
  if (error) throw error
  return result
})

Conf.prototype._invoke = co.wrap(function* ({ functionName, arg }) {
  // confirm if remote was not explicitly specified
  if (!this.remote) {
    yield confirmOrAbort(`You're about to execute an operation on your REMOTE deployment`)
  }

  const {
    StatusCode,
    Payload,
    FunctionError
  } = yield this.lambda.invoke({
    InvocationType: 'RequestResponse',
    FunctionName: this.getLongFunctionName(functionName),
    Payload: JSON.stringify(arg)
  }).promise()

  if (FunctionError || StatusCode >= 300) {
    const message = Payload || FunctionError
    throw new Error(message.toString())
  }

  return JSON.parse(Payload)
})

Conf.prototype.getLongFunctionName = function (functionName) {
  return getLongFunctionName({
    stackName: this.stackName,
    functionName
  })
}

Conf.prototype.getDeployItems = function getDeployItems (opts) {
  opts = normalizeDeployOpts(opts)
  const parts = {}
  if (opts.style) {
    parts.style = read.style()
  }

  if (opts.terms) {
    parts.terms = read.terms()
  }

  if (opts.models) {
    const models = read.models()
    const lenses = read.lenses()
    if (models.length || lenses.length) {
      parts.modelsPack = utils.pack({ models, lenses })
    }
  }

  if (opts.bot) {
    parts.bot = read.bot()
  }

  return parts
}

Conf.prototype._invokeLocal = co.wrap(function* ({ functionName, arg }) {
  const { project, nodeFlags } = this
  const flagsStr = Object.keys(nodeFlags)
    .filter(key => nodeFlags[key])
    .map(key => `--${key}="${nodeFlags[key]}"`)
    .join(' ')

  if (typeof arg !== 'string') arg = JSON.stringify(arg)

  const tmpInput = tmp.fileSync({ postfix: '.json' })
  const tmpOutput = tmp.fileSync({ postfix: '.json' })
  write(tmpInput.name, JSON.stringify(arg))

  const pwd = process.cwd()
  shelljs.cd(project)
  const command =`IS_OFFLINE=1 node ${flagsStr} \
"${project}/node_modules/.bin/sls" invoke local \
-f "${functionName}" \
-l false \
--path "${tmpInput.name}" \
--output "${tmpOutput.name}"`

  debug(`running command: ${command}`)
  const result = shelljs.exec(command, { silent: true })
  shelljs.cd(pwd)
  const res = read(tmpOutput.name).trim()
  if (result.code !== 0) throw new Error(`invoke failed: ${res || result.stderr}`)

  return res && JSON.parse(res)
})

Conf.prototype.load = co.wrap(function* (opts={}) {
  opts = normalizeDeployOpts(opts, 'load')
  logger.info('loading: ', getDeployablesKeys(opts).join(', '))
  if (opts.dryRun) return logger.info('dry run, not executing')

  const result = yield this.exec({
    args: ['getconf --conf']
  })

  if (opts.style && result.style) {
    debug('loaded remote style')
    write(paths.style, result.style)
  }

  if (opts.bot && result.bot) {
    debug('loaded remote bot conf')
    write(paths.bot, result.bot)
  }

  if (opts.terms && result.termsAndConditions) {
    debug('loaded remote terms and conditions')
    write(paths.terms, result.termsAndConditions.value)
  }

  if (opts.models && result.modelsPack) {
    debug('loaded remote models and lenses')
    this.writeModels(result.modelsPack)
  }
})

Conf.prototype.writeModels = co.wrap(function* (modelsPack) {
  yield ['models', 'lenses'].map(co.wrap(function* (prop) {
    const arr = modelsPack[prop]
    if (!arr) return

    yield this.writeToFiles({
      dir: paths[prop],
      arr,
      name: getFileNameForItem
    })
  }).bind(this))
})

Conf.prototype.writeToFiles = co.wrap(function* ({ dir, name, arr }) {
  yield mkdirp(dir)
  yield Promise.all(arr.map(item => {
    return pwrite(path.join(dir, name(item)), item)
  }))
})

Conf.prototype.validate = co.wrap(function* (opts) {
  const items = this.getDeployItems(opts)
  _.each(items, (value, key) => {
    if (typeof value !== 'undefined') {
      debug(`validating: ${key}`)
      validate[key](value)
    }
  })
})

Conf.prototype.exec = co.wrap(function* (opts) {
  const res = yield this.invoke({
    functionName: functions.cli,
    arg: opts.args[0]
  })

  // invoke() returns { error, result }
  let { error, result } = res
  if (error) throw normalizeError(error)

  // cli lambda returns { error, result }
  ;({ error, result } = result)
  if (error) throw normalizeError(error)

  return result
})

Conf.prototype.promptAWSProfile = co.wrap(function* () {
  const awsConf = maybeRead(AWS_CONF_PATH)
  if (awsConf) {
    logger.info('See below your profiles from your ~/.aws/config:\n')
    logger.info(awsConf)
  }

  return yield prompt('Which AWS profile will you be using?')
})

Conf.prototype.promptStackName = co.wrap(function* () {
  const stackInfos = yield this.getStacks()
  const stackNames = stackInfos.map(({ name }) => name)
  let stackName
  do {
    if (!stackName) {
      logger.info('These are the stacks you have in AWS:\n')
      logger.info(stackNames.join('\n'))
      logger.info('\n')
      stackName = yield prompt('Which one is your Tradle stack?')
    }

    if (stackNames.includes(stackName)) {
      break
    }

    logger.error(`You don't have a stack called "${stackName}"!`)
    stackName = null
  } while (true)

  return stackName
})

Conf.prototype.init = co.wrap(function* (opts={}) {
  if (exists('./.env')) {
    yield confirmOrAbort('This will overwrite your .env file')
  }

  const awsProfile = yield this.promptAWSProfile()
  this.profile = awsProfile
  // force reload aws profile
  this.aws = null
  const stackName = yield this.promptStackName()
  const haveLocal = yield prompt('Do you have a local development environment, a clone of https://github.com/tradle/serverless? (y/n)')
  let projectPath
  if (yn(haveLocal)) {
    do {
      let resp = yield prompt('Please provide the path to your project directory, or type "s" to skip')
      if (resp.replace(/["']/g).toLowerCase() === 's') break

      if (isValidProjectPath(resp)) {
        projectPath = path.resolve(resp)
        break
      }

      logger.error('Provided path doesn\'t contain a serverless.yml')
    } while (true)
  }

  const env = {
    awsProfile,
    stackName
  }

  if (projectPath) env.project = projectPath

  write('.env', toEnvFile(env))

  logger.info('wrote .env')
  yield [paths.models, paths.lenses, paths.conf].map(dir => mkdirp(dir))
  logger.success('initialization complete!')
  // logger.info('Would you like to load your currently deployed configuration?')
  // const willLoad = yield prompt('Note: this may overwrite your local files in ./conf, ./models and ./lenses (y/n)')
  // if (!yn(willLoad)) return
})

Conf.prototype._getAWSClient = function (profile) {
  if (!profile) profile = this.profile || process.env.awsProfile
  if (profile) {
    AWS.config.credentials = new AWS.SharedIniFileCredentials({ profile })
  }

  const s3 = new AWS.S3()
  const cloudformation = new AWS.CloudFormation()
  if (profile) {
    cloudformation.config.profile = profile
  }

  return {
    s3,
    cloudformation
  }
}

Conf.prototype.getStacks = co.wrap(function* (profile) {
  const aws = this._getAWSClient(profile)
  return yield utils.listStacks(aws)
})

const createImportDataUtilsMethod = ({
  method,
  props=[],
  required
}) => co.wrap(function* (data) {
  data = _.pick(data, props)
  ;(required || props).forEach(prop => {
    if (!(prop in data)) throw new CustomErrors.InvalidInput(`expected "${prop}"`)
  })

  return yield this.invokeAndReturn({
    functionName: functions.importDataUtils,
    arg: { method, data }
  })
})

Conf.prototype.createDataBundle = co.wrap(function* ({ path }) {
  let bundle
  try {
    bundle = readJSON(path)
  } catch (err) {
    throw new CustomErrors.InvalidInput('expected "path" to bundle')
  }

  return yield this.invokeAndReturn({
    functionName: functions.importDataUtils,
    arg: {
      method: 'createbundle',
      data: bundle
    }
  })
})

Conf.prototype.createDataClaim = createImportDataUtilsMethod({
  method: 'createclaim',
  props: ['key', 'claimType']
})

Conf.prototype.listDataClaims = createImportDataUtilsMethod({
  method: 'listclaims',
  props: ['key']
})

Conf.prototype.getDataBundle = createImportDataUtilsMethod({
  method: 'getbundle',
  props: ['key', 'claimId'],
  required: []
})

Conf.prototype._remoteOnly = function () {
  if (this.local) {
    throw new CustomErrors.InvalidInput('not supported for local dev env')
  }
}

Conf.prototype.destroy = co.wrap(function* (opts) {
  this._remoteOnly()

  const { stackName } = this
  yield confirmOrAbort(`DESTROY REMOTE MYCLOUD ${stackName}?? There's no undo for this one!`)
  yield confirmOrAbort(`Are you REALLY REALLY sure you want to MURDER ${stackName})?`)
  const buckets = yield utils.listStackBucketIds(this.aws, stackName)
  logger.warn(`About to delete buckets:`)
  buckets.forEach(id => logger.info(id))
  yield confirmOrAbort()
  for (const id of buckets) {
    logger.info(`emptying and deleting: ${id}`)
    utils.destroyBucket(this.aws, id)
  }

  yield utils.deleteStack(this.aws, stackName)
})

Conf.prototype.info = co.wrap(function* () {
  this._remoteOnly()

  const links = yield this._invoke({
    functionName: 'cli',
    arg: 'links'
  })

  const apiBaseUrl = yield utils.getApiBaseUrl(this.aws, process.env.stackName)
  const info = yield utils.get(`${apiBaseUrl}/info`)
  return Object.assign(
    { apiBaseUrl },
    { links: links.result },
    _.pick(info, ['version'])
  )
})

Conf.prototype.promptFunction = co.wrap(function* (message) {
  const { aws, stackName } = this
  logger.info('These are your functions:')
  logger.info()
  const functions = yield utils.listStackFunctionIds(aws, stackName)
  const shortNames = functions.map(f => f.slice(stackName.length + 1))
  shortNames.forEach(name => logger.info(name))
  logger.info()
  return yield prompt(message)
})

Conf.prototype.log = co.wrap(function* (opts={}) {
  this._remoteOnly()

  utils.checkCommandInPath('awslogs')

  const { aws, stackName } = this
  let functionName = opts.args[0]
  if (!functionName) {
    functionName = yield this.promptFunction('which one do you want to log?')
  }

  const longName = getLongFunctionName({ stackName, functionName })
  const passThrough = Object.keys(getOptsOnly(opts))
  const awsLogsOpts = passThrough
    .map(opt => {
      const key = utils.splitCamelCase(opt)
        .join('-')
        .toLowerCase()

      const val = opts[opt]
      if (val === true) {
        return `--${key}`
      }

      return `--${key}=${val}`
    })
    .join(' ')

  const cmd = `awslogs get /aws/lambda/${longName} ${awsLogsOpts}`
  logger.info(cmd)
  shelljs.exec(cmd)
})

exports = module.exports = Conf
