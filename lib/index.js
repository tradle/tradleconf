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
const pfs = promisify(fs)
const AWS = require('aws-sdk')
const shelljs = require('shelljs')
const mkdirp = promisify(require('mkdirp'))
const ModelsPack = require('@tradle/models-pack')
const validate = require('./validate')
const utils = require('./utils')
const { debug, prettify } = utils
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

const functions = {
  setconf: 'setconf',
  cli: 'cli'
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

  const { lambda, stackName, local, project, nodeFlags={} } = opts
  if (!lambda) {
    throw new Error('expected "lambda"')
  }

  this.stackName = stackName
  this.lambda = lambda
  this.local = local
  this.project = project
  if (local && !project) {
    throw new Error('expected "project", the path to your local serverless project')
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
  return yield this.invoke({
    functionName: functions.setconf,
    arg: this.getItems(opts)
  })
})

Conf.prototype.invoke = co.wrap(function* (opts) {
  const { functionName, arg, local=this.local } = opts
  if (local) {
    return yield this.invokeLocal(opts)
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

Conf.prototype.getItems = function getItems (opts) {
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

Conf.prototype.invokeLocal = co.wrap(function* ({ functionName, arg }) {
  const { project, nodeFlags } = this
  const flagsStr = Object.keys(nodeFlags)
    .filter(key => nodeFlags[key])
    .map(key => `--${key}="${nodeFlags[key]}"`)
    .join(' ')

  if (typeof arg !== 'string') arg = JSON.stringify(arg)

  const tmpObj = tmp.fileSync()
  const command =`IS_OFFLINE=1 node ${flagsStr} ./node_modules/.bin/sls invoke local -f ${functionName} -l false --output ${tmpObj.name}`
  const pwd = process.cwd()
  shelljs.cd(project)
  const result = shelljs
    // double-stringify to escape string
    .exec(`echo ${JSON.stringify(JSON.stringify(arg))}`, { silent: true })
    // pipe
    .exec(command, { silent: true })

  if (result.code !== 0) {
    throw new Error(result.stderr || `failed with code ${result.code}`)
  }

  shelljs.cd(pwd)
  const res = read(tmpObj.name).trim()
  if (res) {
    return JSON.parse(res)
  }
})

Conf.prototype.load = co.wrap(function* (opts={}) {
  const res = yield this.invoke({
    functionName: functions.cli,
    arg: 'getconf --conf'
  })

  const { error, result } = res
  if (error) throw new Error(JSON.stringify(error))

  if (opts.style && result.style) {
    debug('loaded remote style')
    write(paths.style, result.style)
  }

  if (opts.bot && result.bot) {
    debug('loaded remote bot conf')
    write(paths.bot, result.bot)
  }

  if (opts.terms && result.terms) {
    debug('loaded remote terms and conditions')
    write(paths.terms, result.terms)
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
  const items = this.getItems(opts)
  _.each(items, (value, key) => {
    if (typeof value !== 'undefined') {
      debug(`validating: ${key}`)
      validate[key](value)
    }
  })
})

Conf.prototype.exec = co.wrap(function* (opts) {
  return yield this.invoke({
    functionName: functions.cli,
    arg: opts.args[0]
  })
})

Conf.prototype.init = co.wrap(function* () {
  if (exists('./.env')) {
    console.warn('This will overwrite your .env file')
    let keepGoing = yield promptly.prompt('Continue? (y/n)')
    if (!yn(keepGoing)) return
  }

  const awsConf = maybeRead(AWS_CONF_PATH)
  if (awsConf) {
    console.log('See below your profiles from your ~/.aws/config:\n')
    console.log(awsConf)
  }

  const profile = yield promptly.prompt('Which AWS profile will you be using?')
  const stackNames = yield this.getStacks(profile)
  console.log('These are the stacks you have in AWS:\n')
  console.log(stackNames.join('\n'))
  console.log('\n')
  const stackName = yield promptly.prompt('Which one is your Tradle stack?')
  write('.env', `
aws_profile=${profile}
stack_name=${stackName}
`.trim())

  console.log('wrote .env')
  yield [paths.models, paths.lenses, paths.conf].map(dir => mkdirp(dir))
  console.log('initialization complete!')
  // console.log('Would you like to load your currently deployed configuration?')
  // const willLoad = yield promptly.prompt('Note: this may overwrite your local files in ./conf, ./models and ./lenses (y/n)')
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

exports = module.exports = Conf
