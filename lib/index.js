const path = require('path')
const fs = require('fs')
const os = require('os')
const yn = require('yn')
const tmp = require('tmp')
tmp.setGracefulCleanup() // delete tmp files even on uncaught exception

const _ = require('lodash')
const co = require('co')
const promisify = require('pify')
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
const { debug, prettify, isValidProjectPath, toEnvFile, promptToConfirm } = utils
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
const getLongFunctionName = ({ stackName, functionName }) => `${stackName}-${functionName}`
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

// const getOptsOnly = opts => _.omit(opts, 'args')
const normalizeDeployOpts = (opts, command='deploy') => {
  if (opts.args.length) {
    throw new Error(`unknown arguments: ${opts.args.join(' ')}`)
  }

  const all = opts.all || !_.size(getDeployables(opts))
  if (all) {
    return _.extend({}, DEPLOY_ALL_OPTS, opts)
  }

  if (!_.size(getDeployables(opts))) {
    throw new Error(`you didn't indicate anything to ${command}!`)
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

const initSchema = {
  properties: {
    profile: {
      description: 'your AWS profile',
    },
    stackName: {
      description: 'your Tradle stack name'
    }
  }
}

function Conf (opts) {
  if (!(this instanceof Conf)) {
    return new Conf(opts)
  }

  const { lambda, stackName, local, remote, project, nodeFlags={} } = opts
  if (!lambda) {
    throw new Error('expected "lambda"')
  }

  if (local && remote) {
    throw new Error('expected "local" or "remote" but not both')
  }

  this.stackName = stackName
  this.lambda = lambda
  this.local = local
  this.remote = remote
  this.project = project
  if (local) {
    if (!project) {
      throw new Error('expected "project", the path to your local serverless project')
    }

    if (!isValidProjectPath(project)) {
      throw new Error('expected "project" to point to serverless project dir')
    }
  }

  if (!nodeFlags.inspect && (nodeFlags.debug || nodeFlags['debug-brk'])) {
    nodeFlags.inspect = true
  }

  this.nodeFlags = nodeFlags
}

Conf.prototype._ensureStackName = function () {
  if (!this.stackName) {
    throw new Error('expected "stackName"')
  }
}

Conf.prototype.deploy = co.wrap(function* (opts) {
  const items = this.getDeployItems(opts)
  logger.info('deploying: ', getDeployablesKeys(items).join(', '))
  if (opts.dryRun) return console.log('dry run, not executing')

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
    if (!(yield promptToConfirm(`You're about to execute an operation on your REMOTE deployment`))) {
      throw new CustomErrors.UserAborted()
    }
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
    parts.modelsPack = utils.pack({
      models: read.models(),
      lenses: read.lenses()
    })
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
  if (opts.dryRun) return console.log('dry run, not executing')

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

Conf.prototype.init = co.wrap(function* () {
  if (exists('./.env')) {
    if (!(yield promptToConfirm('This will overwrite your .env file'))) {
      return
    }
  }

  const awsConf = maybeRead(AWS_CONF_PATH)
  if (awsConf) {
    logger.info('See below your profiles from your ~/.aws/config:\n')
    logger.info(awsConf)
  }

  const awsProfile = yield prompt('Which AWS profile will you be using?')
  const stackNames = yield this.getStacks(awsProfile)
  let stackName
  do {
    logger.info('These are the stacks you have in AWS:\n')
    logger.info(stackNames.join('\n'))
    logger.info('\n')

    stackName = yield prompt('Which one is your Tradle stack?')
    if (stackNames.includes(stackName)) {
      break
    }

    logger.error(`You don't have a stack called "${stackName}"!`)
  } while (true)

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

Conf.prototype.getStacks = co.wrap(function* (profile) {
  if (profile) {
    AWS.config.credentials = new AWS.SharedIniFileCredentials({ profile })
  }

  const cloudformation = new AWS.CloudFormation()
  if (profile) {
    cloudformation.config.profile = profile
  }

  const listStacksOpts = {
    StackStatusFilter: ['CREATE_COMPLETE', 'UPDATE_COMPLETE']
  }

  let stackNames = []
  let keepGoing = true
  while (keepGoing) {
    let {
      NextToken,
      StackSummaries
    } = yield cloudformation.listStacks(listStacksOpts).promise()

    stackNames = stackNames.concat(StackSummaries.map(({ StackName }) => StackName))
    listStacksOpts.NextToken = NextToken
    keepGoing = !!NextToken
  }

  return stackNames
})

const createImportDataUtilsMethod = ({
  method,
  props=[],
  required
}) => co.wrap(function* (data) {
  data = _.pick(data, props)
  ;(required || props).forEach(prop => {
    if (!(prop in data)) throw new Error(`expected "${prop}"`)
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
    throw new Error('expected "path" to bundle')
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
  props: ['key']
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

exports = module.exports = Conf
