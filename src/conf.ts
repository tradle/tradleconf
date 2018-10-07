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
} from './prompts'
import { update } from './update'
import { configureKYCServicesStack } from './kyc-services'
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
import { TRADLE_ACCOUNT_ID, BIG_BUCKETS } from './constants'

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
  private client: AWSClients
  private region: string
  private profile: string
  private stackName: string
  private stackId: string
  private namespace: string
  private local: boolean
  private remote: boolean
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

    if (!(haveLocal || haveRemote)) {
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

    const env:any = utils.pickNonNull({
      region,
      awsProfile,
      stackName: this.stackName,
      stackId: this.stackId,
      project: projectPath && path.resolve(process.cwd(), projectPath)
    })

    const saveEnv = async () => {
      write('.env', toEnvFile(env))

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
            env.apiBaseUrl = ctx.info.apiBaseUrl
            env.namespace = ctx.info.org.domain
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
    const lambda = new AWS.Lambda()
    const ecr = new AWS.ECR()
    const ec2 = new AWS.EC2()
    const opsworks = new AWS.OpsWorks()
    // const dynamodb = new AWS.DynamoDB()
    // const docClient = new AWS.DynamoDB.DocClient()
    return {
      s3,
      cloudformation,
      lambda,
      ecr,
      ec2,
      opsworks,
      region: AWS.config.region,
      // dynamodb,
      // docClient
    }
  }

  public getStacks = async (opts={}) => {
    const client = this.createAWSClient(opts)
    return await utils.listStacks(client)
  }

  public waitForStackUpdate = async (opts?:WaitStackOpts) => {
    const { stackName=this.stackName } = opts || {}
    const client = this.createAWSClient()
    await utils.awaitStackUpdate(client, stackName)
  }

  public waitForStackDelete = async (opts?:WaitStackOpts) => {
    const { stackName=this.stackName } = opts || {}
    const client = this.createAWSClient()
    await utils.awaitStackDelete(this.client, stackName)
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

  public destroy = async (opts) => {
    this._ensureStackNameKnown()
    this._ensureRemote()
    const { stackName } = this
    await confirmOrAbort(`DESTROY REMOTE MYCLOUD ${stackName}?? There's no undo for this one!`)
    await confirmOrAbort(`Are you REALLY REALLY sure you want to MURDER ${stackName}?`)
    let buckets = await utils.listStackBucketIds(this.client, stackName)
    buckets.forEach(id => logger.info(id))
    await confirmOrAbort('Delete these buckets?')

    const [big, small] = _.partition(buckets, id => BIG_BUCKETS.find(logical => id.includes(logical.toLowerCase())))

    for (const id of small) {
      logger.info(`emptying and deleting: ${id}`)
      await utils.destroyBucket(this.client, id)
    }

    logger.info('Note: it may take a few minutes for your stack to be deleted')
    await new Listr([
      {
        title: 'disabling termination protection',
        task: async (ctx) => {
          await utils.disableStackTerminationProtection(this.client, stackName)
        }
      },
      {
        title: 'deleting stack',
        task: async (ctx) => {
          await utils.deleteStack(this.client, { StackName: stackName })
          await utils.wait(5000)
          try {
            await this.waitForStackDelete()
          } catch (err) {
            await utils.deleteStack(this.client, { StackName: stackName, RetainResources: BIG_BUCKETS })
          }
        }
      },
    ]).run()

    await Promise.all(big.map(id => utils.markBucketForDeletion(this.client, id)))
    const cleanupScriptPath = path.relative(process.cwd(), this._createCleanupBucketsScript(big))

    logger.info(`The following buckets are too large to delete directly:
${big.join('\n')}

Instead, I've marked them for deletion by S3. They should be emptied within a day or so

After that you can delete them from the console or with this little script I created for you: ${cleanupScriptPath}
`)
  }

  public getApiBaseUrl = async () => {
    if (this.local) {
      return null
    }

    return utils.getApiBaseUrl(this.client, this.stackName)
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
    const info = await this.invokeAndReturn({
      functionName: 'info',
      arg: {},
      noWarning: true
    })

    if (info.statusCode !== 200) {
      throw new CustomErrors.ServerError(info.body)
    }

    if (info.isBase64Encoded) {
      info.body = new Buffer(info.body, 'base64')
    }

    const endpoint = JSON.parse(info.body)
    endpoint.apiBaseUrl = await getApiBaseUrl
    return endpoint
  }

  public getFunctions = async () => {
    this._ensureStackNameKnown()
    const { client, stackName } = this
    return await utils.listStackFunctionIds(client, stackName)
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
    return await this.exec({
      args: ['setenvvar --key DISABLED --value 1']
    })
  }

  public enable = async () => {
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
    if (provider) command = `${command} --provider ${provider}`

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

    await update(this, {
      stackName: this.stackName,
      ...opts,
    })
  }

  public updateManually = async (opts: ApplyUpdateOpts) => {
    await this.applyUpdateAsCurrentUser(opts)
    await this.waitForStackUpdate()
  }

  public rollback = async (opts: UpdateOpts) => {
    this._ensureRemote()
    this._ensureStackNameKnown()

    await update(this, {
      stackName: this.stackName,
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

    if (notificationTopics) {
      params.NotificationARNs = notificationTopics
    }

    await utils.updateStack(this.client, params)
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
    const buckets = await utils.listStackBucketIds(this.client, this.stackName)
    return buckets.find(bucket => /tdl-.*?-ltd-.*?-privateconfbucket/.test(bucket))
  }

  public reboot = async () => {
    this._ensureRemote()
    const functions = await this.getFunctions()
    logger.info(`rebooting functions:\n${functions.join('\n')}`)

    const DATE_UPDATED = String(Date.now())
    await utils.updateEnvironments(this.client, {
      functions,
      transform: ({ name, env }) => ({
        ...env,
        DATE_UPDATED,
      })
    })

    logger.info('warming up rebooted functions')
    await this.warmup()
  }

  public warmup = async () => {
    this._ensureRemote()
    return await this.invokeAndReturn({
      functionName: 'genericJobRunner',
      arg: { name: 'warmup' },
      noWarning: true
    })
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

  private _createCleanupBucketsScript = (buckets: string[]) => {
    const cleanupScript = fs.existsSync(path.resolve(process.cwd(), 'cleanup-buckets.sh'))
      ? `cleanup-buckets-${Date.now()}.sh`
      : `cleanup-buckets.sh`

    const delBuckets = buckets.map(name => getDeleteBucketLine({ name, profile: this.profile }))
    const scriptBody = `
#!/bin/bash

${delBuckets.join('\n')}
`

    const scriptPath = path.resolve(process.cwd(), cleanupScript)
    fs.writeFileSync(scriptPath, scriptBody)
    fs.chmodSync(scriptPath, '0755')
    return scriptPath
  }
}

export const createConf = (opts: ConfOpts) => new Conf(opts)

const stringifyEnv = props => Object.keys(props).map(key => `${key}="${props[key]}"`).join(' ')
const getDeleteBucketLine = ({ name, profile }: {
  name: string
  profile: string
}) => {
  let line = 'aws '
  if (profile) {
    line += `--profile ${profile} `
  }

  line += `s3 rb "s3://${name}"`
  return line
}
