import path = require('path')
import fs = require('fs')
import os = require('os')
import yn = require('yn')
import tmp = require('tmp')
import _ = require('lodash')
import co = require('co')
import promisify = require('pify')
// import YAML = require('js-yaml')
import AWS = require('aws-sdk')
import _mkdirp = require('mkdirp')
import shelljs = require('shelljs')
import Listr = require('listr')
import ModelsPack = require('@tradle/models-pack')
import {
  init as promptInit,
  fn as promptFn,
  confirm
} from './prompts'
import { AWSClients, ConfOpts, NodeFlags } from './types'
import { Errors as CustomErrors } from './errors'
import * as validate from './validate'
import * as utils from './utils'
import { logger, colors } from './logger'

tmp.setGracefulCleanup() // delete tmp files even on uncaught exception

const mkdirp = promisify(_mkdirp)
const pfs = promisify(fs)
const { prettify, isValidProjectPath, toEnvFile, confirmOrAbort } = utils
const AWS_CONF_PATH = `${os.homedir()}/.aws/config`
const getFileNameForItem = item => `${item.id}.json`
const read:any = file => fs.readFileSync(file, { encoding: 'utf8' })
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

const createImportDataUtilsMethod = ({
  method,
  props=[],
  required
}: {
  method: string
  props: string[]
  required?: string[]
}) => async (data) => {
  data = _.pick(data, props)
  ;(required || props).forEach(prop => {
    if (!(prop in data)) throw new CustomErrors.InvalidInput(`expected "${prop}"`)
  })

  return await this.invokeAndReturn({
    functionName: functions.importDataUtils,
    arg: { method, data }
  })
}

type AWSConfigOpts = {
  region?: string
  profile?: string
}

export class Conf {
  private client: AWSClients
  private region: string
  private profile: string
  private stackName: string
  private stackId: string
  private local?: boolean
  private remote?: boolean
  private project?: string
  private nodeFlags?: NodeFlags

  constructor (opts: ConfOpts) {
    const { region, profile, stackName, local, remote, project, nodeFlags={} } = opts

    if (local && remote) {
      throw new CustomErrors.InvalidInput('expected "local" or "remote" but not both')
    }

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

    if (remote && nodeFlags.inspect) {
      throw new CustomErrors.InvalidInput('--debug, --debug-brk are only supported for local operations')
    }

    this.nodeFlags = nodeFlags
    this.region = region
    this.profile = profile
    this.stackName = stackName
    this.local = local
    this.remote = remote
    this.project = project

    let client
    Object.defineProperty(this, 'client', {
      set (value) {
        client = value
      },
      get () {
        if (!client) {
          client = this._getAWSClient()
        }

        return client
      }
    })
  }

  public deploy = async (opts) => {
    const items = this.getDeployItems(opts)
    logger.info('deploying: ', getDeployablesKeys(items).join(', '))
    if (opts.dryRun) return logger.info('dry run, not executing')

    const { error, result } = await this.invoke({
      functionName: functions.setconf,
      arg: items
    })

    if (error) throw error

    return result
  }

  public invoke = async (opts) => {
    let { functionName, arg, local=this.local } = opts
    if (!functionName) functionName = await promptFn(this, 'which function?')

    let result
    try {
      const promise = local ? this._invokeLocal(opts) : this._invoke(opts)
      result = await promise
    } catch (error) {
      return { error }
    }

    return { result }
  }

  public invokeAndReturn = async (opts) => {
    const { error, result } = await this.invoke(opts)
    if (error) throw error
    return result
  }

  public getLongFunctionName = (functionName: string) => getLongFunctionName({
    stackName: this.stackName,
    functionName
  })

  public getDeployItems = (opts:any) => {
    opts = normalizeDeployOpts(opts)
    const parts:any = {}
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

  public load = async (opts:any={}) => {
    opts = normalizeDeployOpts(opts, 'load')
    logger.info('loading: ', getDeployablesKeys(opts).join(', '))
    if (opts.dryRun) return logger.info('dry run, not executing')

    const result = await this.exec({
      args: ['getconf --conf']
    })

    if (opts.style && result.style) {
      logger.debug('loaded remote style')
      write(paths.style, result.style)
    }

    if (opts.bot && result.bot) {
      logger.debug('loaded remote bot conf')
      write(paths.bot, result.bot)
    }

    if (opts.terms && result.termsAndConditions) {
      logger.debug('loaded remote terms and conditions')
      write(paths.terms, result.termsAndConditions.value)
    }

    if (opts.models && result.modelsPack) {
      logger.debug('loaded remote models and lenses')
      this.writeModels(result.modelsPack)
    }
  }

  public writeModels = async (modelsPack) => {
    await ['models', 'lenses'].map(async (prop) => {
      const arr = modelsPack[prop]
      if (!arr) return

      await this.writeToFiles({
        dir: paths[prop],
        arr,
        name: getFileNameForItem
      })
    })
  }

  public writeToFiles = async ({ dir, name, arr }) => {
    await mkdirp(dir)
    await Promise.all(arr.map(item => {
      return pwrite(path.join(dir, name(item)), item)
    }))
  }

  public validate = async (opts) => {
    const items = this.getDeployItems(opts)
    _.each(items, (value, key) => {
      if (typeof value !== 'undefined') {
        logger.debug(`validating: ${key}`)
        validate[key](value)
      }
    })
  }

  public exec = async (opts) => {
    const res = await this.invoke({
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
  }

  public init = async (opts={}) => {
    const {
      overwriteEnv,
      region,
      awsProfile,
      stack,
      projectPath
    } = await promptInit(this)

    if (overwriteEnv === false) return

    this.remote = true
    this.region = region
    this.profile = awsProfile
    this.stackName = stack.name
    this.stackId = stack.id
    // force reload aws profile
    this.client = null

    const env:any = {
      region,
      awsProfile,
      stackName: this.stackName,
      stackId: this.stackId
    }

    const tasks = new Listr([
      {
        title: 'loading deployment info',
        task: async (ctx) => {
          ctx.info = await this.getEndpointInfo()
        }
      },
      {
        title: 'initializing local conf',
        task: async (ctx) => {
          env.apiBaseUrl = ctx.info.apiBaseUrl
          if (projectPath) env.project = path.resolve(process.cwd(), projectPath)

          write('.env', toEnvFile(env))

          // logger.info('wrote .env')
          await Promise.all([
            paths.models,
            paths.lenses,
            paths.conf
          ].map(dir => mkdirp(dir)))
        }
      }
    ])

    await tasks.run()
    logger.success('initialization complete!')
    // logger.info('Would you like to load your currently deployed configuration?')
    // const willLoad = await prompt('Note: this may overwrite your local files in ./conf, ./models and ./lenses (y/n)')
    // if (!yn(willLoad)) return
  }

  private _getAWSClient = (opts:AWSConfigOpts={}) => {
    const {
      profile=this.profile || process.env.awsProfile,
      region=this.region
    } = opts

    if (region) {
      AWS.config.update({ region })
    }

    if (profile) {
      AWS.config.update({
        credentials: new AWS.SharedIniFileCredentials({ profile })
      })
    }

    const s3 = new AWS.S3()
    const cloudformation = new AWS.CloudFormation()
    const lambda = new AWS.Lambda()
    // const dynamodb = new AWS.DynamoDB()
    // const docClient = new AWS.DynamoDB.DocClient()
    return {
      s3,
      cloudformation,
      lambda,
      // dynamodb,
      // docClient
    }
  }

  public getStacks = async (opts={}) => {
    const client = this._getAWSClient(opts)
    return await utils.listStacks(client)
  }

  public createDataBundle = async ({ path }) => {
    let bundle
    try {
      bundle = readJSON(path)
    } catch (err) {
      throw new CustomErrors.InvalidInput('expected "path" to bundle')
    }

    return await this.invokeAndReturn({
      functionName: functions.importDataUtils,
      arg: {
        method: 'createbundle',
        data: bundle
      }
    })
  }

  public createDataClaim = createImportDataUtilsMethod({
    method: 'createclaim',
    props: ['key', 'claimType']
  })

  public listDataClaims = createImportDataUtilsMethod({
    method: 'listclaims',
    props: ['key']
  })

  public getDataBundle = createImportDataUtilsMethod({
    method: 'getbundle',
    props: ['key', 'claimId'],
    required: []
  })

  private _ensureRemote = () => {
    if (this.local) {
      throw new CustomErrors.InvalidInput('not supported for local dev env')
    }
  }

  public destroy = async (opts) => {
    this._ensureStackName()
    this._ensureRemote()
    const { stackName } = this
    await confirmOrAbort(`DESTROY REMOTE MYCLOUD ${stackName}?? There's no undo for this one!`)
    await confirmOrAbort(`Are you REALLY REALLY sure you want to MURDER ${stackName})?`)
    const buckets = await utils.listStackBucketIds(this.client, stackName)
    buckets.forEach(id => logger.info(id))
    await confirmOrAbort('Delete these buckets?')
    for (const id of buckets) {
      logger.info(`emptying and deleting: ${id}`)
      utils.destroyBucket(this.client, id)
    }

    await utils.deleteStack(this.client, stackName)
    logger.info('Note: it may take a few minutes for your stack to be deleted')
  }

  public getApiBaseUrl = async () => {
    if (this.local) {
      return null
    }

    return utils.getApiBaseUrl(this.client, this.stackName)
  }

  public info = async () => {
    this._ensureStackName()
    return await this._info()
  }

  public _info = async () => {
    const getLinks = this.invokeAndReturn({
      functionName: 'cli',
      arg: 'links',
      noWarning: true
    })

    const getInfo = this.getEndpointInfo()
    const [links, info] = await Promise.all([getLinks, getInfo])
    return Object.assign(
      { links },
      _.pick(info, ['version', 'chainKey', 'apiBaseUrl'])
    )
  }

  public getEndpointInfo = async () => {
    const getApiBaseUrl = this.getApiBaseUrl()
    const info = await this.invokeAndReturn({ functionName: 'info', arg: {} })
    if (info.isBase64Encoded) {
      info.body = new Buffer(info.body, 'base64')
    }

    const endpoint = JSON.parse(info.body)
    endpoint.apiBaseUrl = await getApiBaseUrl
    return endpoint
  }

  public getFunctions = async () => {
    this._ensureStackName()
    const { client, stackName } = this
    const functions = await utils.listStackFunctionIds(client, stackName)
    return functions.map(f => f.slice(stackName.length + 1))
  }

  public tail = async (opts:any={}) => {
    return this.log({ watch: true, ...opts })
  }

  public log = async (opts:any={}) => {
    this._ensureStackName()
    this._ensureRemote()

    utils.checkCommandInPath('awslogs')

    const { client, stackName } = this
    let functionName = opts.args[0]
    if (!functionName) {
      functionName = await promptFn(this, 'which one do you want to log?')
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
  }

  private _ensureStackName = () => {
    if (!this.stackName) {
      throw new CustomErrors.InvalidInput(`don't know stack name. Did you forget to run "init"?`)
    }
  }

  private _invoke = async ({ functionName, arg={}, noWarning }: {
    functionName: string
    arg?: any
    noWarning?: boolean
  }) => {
    // confirm if remote was not explicitly specified
    if (!(this.remote || noWarning)) {
      await confirmOrAbort(`Targeting REMOTE deployment. Continue?`)
    }

    this._ensureStackName()

    const {
      StatusCode,
      Payload,
      FunctionError
    } = await this.client.lambda.invoke({
      InvocationType: 'RequestResponse',
      FunctionName: this.getLongFunctionName(functionName),
      Payload: JSON.stringify(arg)
    }).promise()

    if (FunctionError || StatusCode >= 300) {
      const message = Payload || FunctionError
      throw new Error(message.toString())
    }

    return JSON.parse(Payload.toString())
  }

  private _invokeLocal = async ({ functionName, arg }) => {
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
    logger.debug('be patient, local invocations can be slow')
    const command =`IS_OFFLINE=1 node ${flagsStr} \
  "${project}/node_modules/.bin/sls" invoke local \
  -f "${functionName}" \
  -l false \
  --path "${tmpInput.name}" \
  --output "${tmpOutput.name}"`

    logger.debug(`running command: ${command}`)
    const result = shelljs.exec(command, { silent: true })
    shelljs.cd(pwd)
    const res = read(tmpOutput.name).trim()
    if (result.code !== 0) throw new Error(`invoke failed: ${res || result.stderr}`)

    return res && JSON.parse(res)
  }
}

export const createConf = (opts: ConfOpts) => new Conf(opts)
