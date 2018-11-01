import path from 'path'
import fs from 'fs'
import os from 'os'
import yn from 'yn'
import tmp from 'tmp'
import _ from 'lodash'
import co from 'co'
import promisify from 'pify'
import promiseRetry from 'promise-retry'
// import YAML from 'js-yaml'
import AWS from 'aws-sdk'
import _mkdirp from 'mkdirp'
import shelljs from 'shelljs'
import Listr from 'listr'
import Errors from '@tradle/errors'
import ModelsPack from '@tradle/models-pack'
import {
  init as promptInit,
  fn as promptFn,
  confirmOrAbort,
  confirm,
} from './prompts'
import { update } from './update'
import { destroy, deleteCorrespondingServicesStack } from './destroy'
import {
  restoreStack,
  deriveParametersFromStack,
  restoreResources,
} from './restore'

import { create as wrapS3 } from './s3'

import { configureKYCServicesStack, getStackId as getServicesStackId } from './kyc-services'
import {
  AWSClients,
  ConfOpts,
  NodeFlags,
  UpdateOpts,
  InvokeOpts,
  WaitStackOpts,
  VersionInfo,
  GetUpdateInfoResp,
  ApplyUpdateOpts,
  SetKYCServicesOpts,
} from './types'
import { Errors as CustomErrors } from './errors'
import * as validate from './validate'
import * as utils from './utils'
import { logger, colors } from './logger'

tmp.setGracefulCleanup() // delete tmp files even on uncaught exception

const mkdirp = promisify(_mkdirp)
const pfs = promisify(fs)
const { prettify, isValidProjectPath, toEnvFile } = utils
const silentLogger = Object.keys(logger).reduce((silent, method) => {
  silent[method] = () => {}
  return silent
}, {})

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

const readDirOfJSONs = dir => fs.readdirSync(dir)
  .filter(file => file.endsWith('.json'))
  .map(file => require(path.resolve(dir, file)))

const DEPLOYABLES = [
  'bot',
  'style',
  'models',
  'modelsPack',
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
  if (!_.isEmpty(opts.args)) {
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
  conf,
  method,
  props=[],
  required
}: {
  conf: Conf
  method: string
  props: string[]
  required?: string[]
}) => async (data) => {
  data = _.pick(data, props)
  ;(required || props).forEach(prop => {
    if (!(prop in data)) throw new CustomErrors.InvalidInput(`expected "${prop}"`)
  })

  return await conf.invokeAndReturn({
    functionName: functions.importDataUtils,
    arg: { method, data }
  })
}

type AWSConfigOpts = {
  region?: string
  profile?: string
}

export class Conf {
  public local: boolean
  public remote: boolean
  public client: AWSClients
  public profile: string

  private region: string
  private stackName: string
  private stackId: string
  private namespace: string
  private apiBaseUrl: string
  private project?: string
  private nodeFlags?: NodeFlags

  constructor (opts: ConfOpts) {
    const { remote, region, profile, namespace, stackId, stackName, project, nodeFlags={} } = opts

    if (typeof remote !== 'boolean') {
      throw new CustomErrors.InvalidInput(`expected boolean "remote"`)
    }

    if (remote && !_.isEmpty(nodeFlags)) {
      throw new CustomErrors.InvalidInput('node debugging flags are only supported for local operations')
    }

    utils.normalizeNodeFlags(nodeFlags)

    this.nodeFlags = nodeFlags
    this.region = region
    this.namespace = namespace
    this.profile = profile
    this.stackName = stackName
    this.stackId = stackId
    this.project = project
    this.remote = remote
    this.local = !remote

    let client
    Object.defineProperty(this, 'client', {
      set (value) {
        client = value
      },
      get () {
        if (!client) {
          client = this.createAWSClient()
        }

        return client
      }
    })
  }

  public deploy = async (opts) => {
    const items = this.getDeployItems(opts)
    logger.info(`deploying: ${getDeployablesKeys(items).join(', ')}`)
    if (opts.dryRun) return logger.info('dry run, not executing')

    const { error, result } = await this.invoke({
      functionName: functions.setconf,
      arg: items
    })

    if (error) throw error

    return result
  }

  public invoke = async (opts) => {
    let { functionName, arg } = opts
    if (!functionName) functionName = await promptFn(this, 'which function?')

    let result
    try {
      const promise = this.remote ? this._invoke(opts) : this._invokeLocal(opts)
      result = await promise
    } catch (error) {
      return { error }
    }

    return utils.unwrapReturnValue({ result })
  }

  public invokeAndReturn = async (opts: InvokeOpts) => {
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
      // "null" for delete
      parts.terms = read.terms() || null
    }

    if (opts.models) {
      const models = read.models()
      const lenses = read.lenses()
      if (models.length || lenses.length) {
        parts.modelsPack = utils.pack({ models, lenses, namespace: this.namespace })
      }
    }

    if (opts.bot) {
      parts.bot = read.bot()
    }

    return parts
  }

  public load = async (opts:any={}) => {
    const opLogger = opts.logger || logger
    opts = normalizeDeployOpts(opts, 'load')
    opLogger.info(`loading: ${getDeployablesKeys(opts).join(', ')}\n`)
    if (opts.dryRun) return opLogger.info('dry run, not executing')

    const result = await this.exec({
      args: ['getconf --conf']
    })

    if (opts.style && result.style) {
      opLogger.debug('loaded remote style')
      write(paths.style, result.style)
    }

    if (opts.bot && result.bot) {
      opLogger.debug('loaded remote bot conf')
      write(paths.bot, result.bot)
    }

    if (opts.terms && result.termsAndConditions) {
      opLogger.debug('loaded remote terms and conditions')
      write(paths.terms, result.termsAndConditions.value)
    }

    if (opts.models && result.modelsPack) {
      opLogger.debug('loaded remote models and lenses')
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
      if (!validate[key]) {
        logger.info(`validation for ${key} will be done in cloud-side on deploy`)
        return
      }

      if (typeof value !== 'undefined') {
        logger.debug(`validating: ${key}`)
        validate[key](value)
      }
    })
  }

  public exec = async (opts) => {
    const { error, result } = await this.invoke({
      functionName: functions.cli,
      arg: opts.args[0],
      noWarning: opts.noWarning
    })

    if (error) throw error

    // cli lambda returns { error, result }
    if (!result) {
      throw new CustomErrors.ServerError('something went wrong, please wait a minute and try again')
    }

    return result
  }

  public init = async (opts={}) => {
    const {
      haveLocal,
      haveRemote,
      overwriteEnv,
      region,
      awsProfile,
      stack={},
      projectPath,
      loadCurrentConf,
    } = await promptInit(this)

    if (overwriteEnv === false) return

    if (!(haveRemote || projectPath)) {
      logger.warn("Aborting. Re-run `tradleconf init` when you've either deployed a MyCloud, or have a local development environment, or both")
      return
    }

    this.remote = haveRemote
    this.region = region
    this.profile = awsProfile
    this.stackName = stack.name
    this.stackId = stack.id
    // force reload aws profile
    this.client = null
    this.project = projectPath && path.resolve(process.cwd(), projectPath)

    const saveEnv = async () => {
      this._saveEnv()

      // logger.info('wrote .env')
      await Promise.all([
        paths.models,
        paths.lenses,
        paths.conf
      ].map(dir => mkdirp(dir)))
    }

    const saveEnvTask = {
      title: 'saving .env',
      task: saveEnv
    }

    if (haveRemote) {
      const tasks = [
        {
          title: 'loading deployment info',
          task: async (ctx) => {
            ctx.info = await this.getEndpointInfo()
          }
        },
        {
          title: 'initializing local conf',
          task: async (ctx) => {
            this.apiBaseUrl = ctx.info.apiBaseUrl
            this.namespace = ctx.info.org.domain
              .split('.')
              .reverse()
              .join('.')
          }
        },
        saveEnvTask,
      ]

      if (loadCurrentConf) {
        tasks.push({
          title: 'loading remote configuration',
          task: async () => this.load({ all: true, logger: silentLogger }),
        })
      }

      await new Listr(tasks).run()
    } else {
      await saveEnv()
    }

    logger.success('initialization complete!')
    // logger.info('Would you like to load your currently deployed configuration?')
    // const willLoad = await prompt('Note: this may overwrite your local files in ./conf, ./models and ./lenses (y/n)')
    // if (!yn(willLoad)) return
  }

  public createAWSClient = (opts:AWSConfigOpts={}) => {
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
    const logs = new AWS.CloudWatchLogs()
    const lambda = new AWS.Lambda()
    const ecr = new AWS.ECR()
    const ec2 = new AWS.EC2()
    const opsworks = new AWS.OpsWorks()
    const dynamodb = new AWS.DynamoDB()
    const kms = new AWS.KMS()
    const apigateway = new AWS.APIGateway()
    // const docClient = new AWS.DynamoDB.DocClient()
    return {
      s3,
      cloudformation,
      lambda,
      ecr,
      ec2,
      opsworks,
      region: AWS.config.region,
      dynamodb,
      logs,
      // docClient,
      kms,
      apigateway,
    }
  }

  public getStacks = async (opts={}) => {
    const client = this.createAWSClient(opts)
    return await utils.listStacks(client.cloudformation)
  }

  public waitForStackUpdate = async (opts?:WaitStackOpts) => {
    const { stackId=this.stackId } = opts || {}
    const client = this.createAWSClient()
    await utils.awaitStackUpdate(client.cloudformation, stackId)
  }

  public waitForStackDelete = async (opts?:WaitStackOpts) => {
    const { stackId=this.stackId } = opts || {}
    const client = this.createAWSClient()
    await utils.awaitStackDelete(client.cloudformation, stackId)
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

  private _createDataClaim = createImportDataUtilsMethod({
    conf: this,
    method: 'createclaim',
    props: ['key', 'claimType']
  })

  public createDataClaim = async (opts) => {
    const { qrCode } = opts
    if (qrCode && !qrCode.endsWith('.png')) {
      throw new CustomErrors.InvalidInput(`expected qr code path to end with .png`)
    }

    const result = await this._createDataClaim(opts)
    if (qrCode) {
      const { qrData } = result
      await utils.createQRCode(qrCode, qrData)
      logger.info(`wrote qr code to: ${qrCode}\n`)
    }

    return result
  }

  public listDataClaims = createImportDataUtilsMethod({
    conf: this,
    method: 'listclaims',
    props: ['key']
  })

  public getDataBundle = createImportDataUtilsMethod({
    conf: this,
    method: 'getbundle',
    props: ['key', 'claimId'],
    required: []
  })

  private _ensureRemote = () => {
    if (!this.remote) {
      throw new CustomErrors.InvalidInput('not supported for local dev env')
    }
  }

  public destroy = async ({ profile=this.profile, stackArn=this.stackId }) => {
    if (!stackArn) {
      this._ensureStackNameKnown()
      this._ensureRemote()
    }

    await destroy({
      client: this.createAWSClient({ profile, region: this.region }),
      profile,
      stackId: stackArn,
    })
  }

  public getApiBaseUrl = async () => {
    if (this.local) {
      return null
    }

    return utils.getApiBaseUrl(this.client.cloudformation, this.stackName)
  }

  public info = async () => {
    this._ensureStackNameKnown()
    return await this._info()
  }

  public _info = async () => {
    const getLinks = this.invokeAndReturn({
      functionName: 'cli',
      arg: 'links',
      noWarning: true
    })

    const getInfo = this.remote ? this.getEndpointInfo() : Promise.resolve({})
    const [links, info] = await Promise.all([getLinks, getInfo])
    return Object.assign(
      { links },
      _.pick(info, ['version', 'chainKey', 'apiBaseUrl'])
    )
  }

  public getEndpointInfo = async () => {
    const getApiBaseUrl = this.getApiBaseUrl()
    const getInfo = this.invokeAndReturn({
      functionName: 'info',
      arg: {},
      noWarning: true
    })

    const [apiBaseUrl, info] = await Promise.all([getApiBaseUrl, getInfo])
    if (info.statusCode !== 200) {
      throw new CustomErrors.ServerError(info.body)
    }

    if (info.isBase64Encoded) {
      info.body = new Buffer(info.body, 'base64')
    }

    const endpoint = JSON.parse(info.body)
    endpoint.apiBaseUrl = apiBaseUrl
    return endpoint
  }

  public getFunctions = async () => {
    this._ensureStackNameKnown()
    const { client, stackName } = this
    return await utils.listStackFunctionIds(client.cloudformation, stackName)
  }

  public getFunctionShortNames = async () => {
    const functions = await this.getFunctions()
    return functions.map(f => f.slice(this.stackName.length + 1))
  }

  public tail = async (opts:any={}) => {
    return this.log({ watch: true, ...opts })
  }

  public log = async (opts:any={}) => {
    this._ensureStackNameKnown()
    this._ensureRemote()

    utils.checkCommandInPath('awslogs')

    const { client, stackName } = this
    let functionName = opts.args[0]
    if (!functionName) {
      functionName = await promptFn(this, 'which one do you want to log?')
    }

    const longName = getLongFunctionName({ stackName, functionName })
    const logOpts = getOptsOnly(opts)
    if (!(logOpts.start || logOpts.end)) {
      logOpts.start = '5m'
    }

    if (this.profile) logOpts.profile = this.profile
    if (this.region) logOpts['aws-region'] = this.region

    const passThrough = Object.keys(logOpts)
    const logOptsStr = passThrough
      .map(opt => {
        const key = utils.splitCamelCase(opt)
          .join('-')
          .toLowerCase()

        const val = logOpts[opt]
        if (val === true) {
          return `--${key}`
        }

        return `--${key}=${val}`
      })
      .join(' ')

    const cmd = `awslogs get /aws/lambda/${longName} ${logOptsStr}`
    logger.info(cmd)
    shelljs.exec(cmd)
  }

  public balance = async () => {
    return await this.exec({
      args: ['balance']
    })
  }

  public disable = async () => {
    this._ensureRemote()
    return await this.exec({
      args: ['setenvvar --key DISABLED --value 1']
    })
  }

  public enable = async () => {
    this._ensureRemote()
    return await this.exec({
      args: ['setenvvar --key DISABLED']
    })
  }

  public query = async (query: string) => {
    const queryString = JSON.stringify(query.replace(/[\s]/g, ' '))
    return await this.exec({
      args: [`graphql --query ${queryString}`]
    })
  }

  public getMyIdentity = async () => {
    return await this.invokeAndReturn({
      functionName: 'cli',
      arg: 'identity',
      noWarning: true
    })
  }

  public getMyPermalink = async () => {
    const identity = await this.getMyIdentity()
    return identity._permalink
  }

  public getCurrentVersion = async ():Promise<VersionInfo> => {
    const versions = await this.exec({
      args: ['listmyversions --limit 1'],
      noWarning: true
    })

    return versions[0]
    // const { version } = await this.info()
    // return version
  }

  public listUpdates = async ({ provider }: {
    provider?: string
  }={}):Promise<VersionInfo[]> => {
    let command = 'listupdates'
    // temporarily double-specified for backwards compat
    // TODO: remove --provider-permalink
    if (provider) {
      command = `${command} --provider ${provider} --provider-permalink ${provider}`
    }

    return await this.exec({
      args: [command],
      noWarning: true
    })
  }

  public listPreviousVersions = async ():Promise<VersionInfo[]> => {
    return await this.exec({
      args: [`listmyversions`],
      noWarning: true
    })
  }

  public requestUpdate = async ({ tag, provider }) => {
    if (!tag) throw new CustomErrors.InvalidInput('expected string "tag"')

    this._ensureRemote()
    let command = `getupdate --tag "${tag}"`
    if (provider) command = `${command} --provider ${provider}`

    await this.exec({
      args: [command],
      noWarning: true
    })
  }

  public getUpdateInfo = async ({ tag }):Promise<GetUpdateInfoResp> => {
    this._ensureRemote()
    const result = await this.exec({
      args: [`getupdateinfo --tag "${tag}"`],
      noWarning: true
    })

    if (!result.update) {
      throw new CustomErrors.NotFound(`not found: update with version: ${tag}`)
    }

    return result
  }

  public update = async (opts: UpdateOpts) => {
    this._ensureRemote()
    this._ensureStackNameKnown()

    const result = await update(this, {
      stackId: this.stackId,
      ...opts,
    })

    if (result.recreated) {
      await this._requestReinit()
    }
  }

  public updateManually = async (opts: ApplyUpdateOpts) => {
    await this.applyUpdateAsCurrentUser(opts)
  }

  public rollback = async (opts: UpdateOpts) => {
    this._ensureRemote()
    this._ensureStackNameKnown()

    await update(this, {
      stackId: this.stackId,
      rollback: true,
      ...opts,
    })
  }

  public applyUpdateAsCurrentUser = async (update: ApplyUpdateOpts) => {
    this._ensureRemote()
    this._ensureStackNameKnown()
    const { templateUrl, notificationTopics } = update
    const params:AWS.CloudFormation.UpdateStackInput = {
      StackName: this.stackId || this.stackName,
      TemplateURL: templateUrl,
      Capabilities: ['CAPABILITY_NAMED_IAM'],
    }

    if (update.parameters) {
      params.Parameters = update.parameters
    }

    if (notificationTopics) {
      params.NotificationARNs = notificationTopics
    }

    await utils.updateStack({ cloudformation: this.client.cloudformation, params })
  }

  public applyUpdateViaLambda = async (update) => {
    const { templateUrl, notificationTopics } = update
    return await this.invokeAndReturn({
      functionName: 'updateStack',
      arg: { templateUrl, notificationTopics }
    })
  }

  public enableKYCServices = async () => {
    return this.setKYCServices({ rankOne: true, truefaceSpoof: true })
  }

  public disableKYCServices = async ({ servicesStackArn, ...opts }) => {
    if (servicesStackArn) {
      const task = {
        title: `delete stack: ${servicesStackArn}`,
        task: async () => {
          await utils.deleteStackAndWait({
            cloudformation: this.client.cloudformation,
            params: {
              StackName: servicesStackArn
            },
          })
        }
      }

      return await new Listr([task]).run()
    }

    return deleteCorrespondingServicesStack({
      client: this.client,
      profile: this.profile,
      stackId: this.stackId,
    })
  }

  public setKYCServices = async ({ truefaceSpoof, rankOne }: SetKYCServicesOpts) => {
    this._ensureRemote()
    this._ensureRegionKnown()
    await configureKYCServicesStack(this, {
      truefaceSpoof,
      rankOne,
      mycloudStackName: this.stackName,
      mycloudRegion: this.region,
      client: this.client,
    })
  }

  public getPrivateConfBucket = async () => {
    this._ensureStackNameKnown()
    const buckets = await utils.listStackBucketIds(this.client.cloudformation, this.stackName)
    return buckets.find(bucket => /tdl-.*?-ltd-.*?-privateconfbucket/.test(bucket))
  }

  public reboot = async () => {
    this._ensureRemote()
    const functions = await this.getFunctions()
    logger.info(`rebooting functions:\n${functions.join('\n')}`)

    const DATE_UPDATED = String(Date.now())
    await utils.updateEnvironments(this.client.lambda, {
      functions,
      transform: ({ name, env }) => ({
        ...env,
        DATE_UPDATED,
      })
    })

    logger.info('warming up rebooted functions')
    await this.warmup()
  }

  public getStackTemplate = async ({ output }) => {
    this._ensureRemote()
    this._ensureStackNameKnown()
    const template = await utils.getStackTemplate({
      cloudformation: this.client.cloudformation,
      stackId: this.stackId
    })

    const outputPath = output.startsWith('/') ? output : path.resolve(process.cwd(), output)
    write(outputPath, template)
  }

  public warmup = async () => {
    this._ensureRemote()
    return await this.invokeAndReturn({
      functionName: 'genericJobRunner',
      arg: { name: 'warmup' },
      noWarning: true
    })
  }

  public restoreFromStack = async (opts) => {
    this._ensureRemote()
    this._ensureInitialized()

    let {
      sourceStackArn=this.stackId,
      newStackName=this.stackName,
      stackParameters
    } = opts

    if (stackParameters) {
      stackParameters = readJSON(stackParameters)
    }

    await restoreStack({
      ...opts,
      conf: this,
      sourceStackArn,
      stackParameters,
      newStackName,
    })

    await this._requestReinit()
  }

  public restoreResources = async (opts) => {
    this._ensureRemote()

    const { date, sourceStackArn=this.stackId, output } = opts
    if (!sourceStackArn) {
      this._ensureInitialized()
    }

    const params = await restoreResources({
      client: this.client,
      profile: this.profile,
      region: this.region,
      sourceStackArn,
      date,
    })

    if (output) {
      write(path.resolve(process.cwd(), output), params)
    } else {
      console.log(prettify(params))
    }
  }

  public restoreBucket = async opts => {
    const s3 = wrapS3(this.client.s3)
    await s3.restoreBucket({ ...opts, profile: this.profile })
  }

  public genStackParameters = async (opts) => {
    this._ensureRemote()
    const { sourceStackArn=this.stackId, output } = opts
    const { region } = utils.parseStackArn(sourceStackArn)
    const params = await deriveParametersFromStack({
      client: this.createAWSClient({ region }),
      stackId: sourceStackArn
    })

    if (output) {
      write(path.resolve(process.cwd(), output), params)
    } else {
      console.log(prettify(params))
    }
  }

  private _ensureStackNameKnown = () => {
    if (this.remote && !this.stackName) {
      throw new CustomErrors.InvalidInput(`hm...are you sure you're in the right directory?`)
    }
  }

  private _ensureRegionKnown = () => {
    if (this.remote && !this.region) {
      throw new CustomErrors.InvalidInput(`please re-run 'tradelconf init', your .env file is outdated`)
    }
  }

  private _ensureInitialized = () => {
    if (!fs.existsSync(path.resolve(process.cwd(), '.env'))) {
      throw new CustomErrors.InvalidInput(`hm...are you sure you're in the right directory? I don't see a .env file`)
    }
  }

  private _invoke = async ({ functionName, arg={}, noWarning }: InvokeOpts) => {
    // confirm if remote was not explicitly specified
    if (!(this.remote || noWarning)) {
      await confirmOrAbort(`Targeting REMOTE deployment. Continue?`)
    }

    this._ensureStackNameKnown()

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

  private _invokeLocal = async ({ functionName, arg }: InvokeOpts) => {
    const { project, nodeFlags } = this
    const flagsStr = Object.keys(nodeFlags)
      .filter(key => nodeFlags[key])
      .map(key => `--${key}`)
      .join(' ')

    if (typeof arg !== 'string') arg = JSON.stringify(arg)

    const tmpInput = tmp.fileSync({ postfix: '.json' })
    const tmpOutput = tmp.fileSync({ postfix: '.json' })
    write(tmpInput.name, JSON.stringify(arg))

    const pwd = process.cwd()
    shelljs.cd(project)
    logger.debug('be patient, local invocations can be slow')
    const envVars:any = _.pick(process.env, ['SERVERLESS_OFFLINE_APIGW'])
    if (!envVars.IS_OFFLINE) envVars.IS_OFFLINE = '1'

    const command =`${stringifyEnv(envVars)} node ${flagsStr} \
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

  private _saveEnv = () => {
    const env = utils.pickNonNull({
      region: this.region,
      awsProfile: this.profile,
      stackName: this.stackName,
      stackId: this.stackId,
      project: this.project,
    })

    write('.env', toEnvFile(env))
  }

  private _requestReinit = async () => {
    logger.info('you should re-init, as your stack information has changed')
    await this.init({ remote: true })
  }
}

export const createConf = (opts: ConfOpts) => new Conf(opts)

const stringifyEnv = props => Object.keys(props).map(key => `${key}="${props[key]}"`).join(' ')
