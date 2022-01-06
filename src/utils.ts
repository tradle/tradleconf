import crypto from 'crypto'
import path from 'path'
import fs from 'fs'
import _ from 'lodash'
import co from 'co'
import yn from 'yn'
import promisify from 'pify'
import promptly from 'promptly'
import chalk from 'chalk'
import shelljs from 'shelljs'
import fetch from 'node-fetch'
import AWS from 'aws-sdk'
import YAML from 'js-yaml'
import Listr from 'listr'
import ModelsPack from '@tradle/models-pack'
import Errors from '@tradle/errors'
import parseS3Url from 'amazon-s3-uri'
import { emptyBucket } from './empty-bucket'
import { logger, colors } from './logger'
import { Errors as CustomErrors } from './errors'
import { confirm } from './prompts'
import {
  ConfOpts,
  CloudResource,
  CloudResourceType,
  RestoreTableCliOpts,
  ClientOpts,
  CFParameter,
  CFResource,
  CFTemplate,
  CFParameterDef,
  CFParameterDefMap,
  AWSClients,
} from './types'

import { REMOTE_ONLY_COMMANDS, SAFE_REMOTE_COMMANDS } from './constants'

export { parseS3Url }

interface CreateStackOpts {
  cloudformation: AWS.CloudFormation
  params: AWS.CloudFormation.CreateStackInput
}

interface UpdateStackOpts {
  cloudformation: AWS.CloudFormation
  params: AWS.CloudFormation.UpdateStackInput
}

interface DeleteStackOpts {
  cloudformation: AWS.CloudFormation
  params: AWS.CloudFormation.DeleteStackInput
}

interface UpdateStackInRegionOpts {
  region: string
  params: AWS.CloudFormation.UpdateStackInput
}

interface CreateStackInRegionOpts {
  region: string
  params: AWS.CloudFormation.CreateStackInput
}

interface S3OpBaseOpts {
  s3: AWS.S3
  bucket: string
}

interface S3EncOpBaseOpts extends S3OpBaseOpts {
  kms: AWS.KMS
}

interface S3ObjectOpBaseOpts extends S3OpBaseOpts {
  key: string
}

interface S3SetBucketExpirationOpts extends S3OpBaseOpts {
  days: number
}

interface S3SetBucketLifeCycleRuleOpts extends S3OpBaseOpts {
  filter: (rule: AWS.S3.LifecycleRule) => boolean
  create: () => AWS.S3.LifecycleRule
  update: (rule: AWS.S3.LifecycleRule) => void
}

interface S3SetBucketTransitionOpts extends S3OpBaseOpts {
  days: number
}

interface StackInfoParams {
  cloudformation: AWS.CloudFormation
  stackId: string
}

interface TableParams {
  dynamodb: AWS.DynamoDB
  tableName: string
}

interface SetTableBillingModeParams extends TableParams {
  billingMode: AWS.DynamoDB.BillingMode
}

export const MY_CLOUD_STACK_NAME_REGEX = /^tdl-([a-zA-Z0-9-]*?)-ltd-([a-z0-9]+)$/
export const MY_CLOUD_STACK_NAME_STRICTER_REGEX = /^tdl-([a-z0-9]*?)-ltd-([a-z0-9]+)$/

const NOT_FOUND_ERRORS = [
  { code: 'NotFound' }, // s3
  { code: 'NoSuchBucket' }, // s3
  { code: 'NoSuchKey' }, // s3
  { code: 'NoSuchLifecycleConfiguration' }, // s3
  { code: 'NotFoundException' }, // delete restapi
  { code: 'ResourceNotFoundException' }, // dynamodb, misc
]

const ignoreNotFound = err => Errors.ignore(err, NOT_FOUND_ERRORS)

export const get = async (url) => {
  const res = await fetch(url)
  if (res.statusCode > 300) {
    throw new Error(res.statusText)
  }

  return await res.json()
}

export const getNamespace = ({ models, lenses }) => {
  const model = _.values(models)[0] || _.values(lenses)[0]
  return model && ModelsPack.getNamespace(model.id)
}

export const pack = ({ namespace, models, lenses }: {
  namespace?: string
  models?: any
  lenses?: any
}) => {
  if (!(_.size(models) || _.size(lenses))) {
    throw new CustomErrors.InvalidInput('expected "models" and/or "lenses"')
  }

  if (!namespace) {
    namespace = getNamespace({ models, lenses })
  }

  const modelsPack = ModelsPack.pack({ namespace, models, lenses })
  return modelsPack
}

export const prettify = obj => {
  return typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2)
}

export const isValidProjectPath = project => {
  return fs.existsSync(path.resolve(project, 'serverless.yml'))
}

export const toEnvFile = obj => Object.keys(obj)
  .map(key => `${key}="${obj[key]}"`)
  .join('\n')

type StackResourceSummaryFilter = (item: AWS.CloudFormation.StackResourceSummary) => boolean

const acceptAll = (item: any) => true

const isRetained = ({ DeletionPolicy }) => DeletionPolicy === 'Retain'
const getRetainedResources = (template: any) => Object.keys(template.Resources)
  .filter(logicalId => isRetained(template.Resources[logicalId]))

export const getStackTemplates = async (cloudformation: AWS.CloudFormation, stackId: string) => {
  const main = await getStackTemplate({ cloudformation, stackId })
  const nested = await listSubstacks(cloudformation, stackId)
  if (!nested.length) return [main]

  const nestedTemplates = _.flatten(await Promise.all(nested.map(n => getStackTemplates(cloudformation, n.PhysicalResourceId))))
  return [main].concat(nestedTemplates)
}

export const isV1Stack = async ({ cloudformation, stackId }: StackInfoParams):Promise<boolean> => {
  const childStacks = await listSubstacks(cloudformation, stackId)
  return childStacks.length === 0
}

export const isV2Template = (template: CFTemplate) => {
  return _.some(template.Resources, (value: CFResource) => value.Type === 'AWS::CloudFormation::Stack')
}

export const getStackInfo = async ({ cloudformation, stackId }: StackInfoParams):Promise<AWS.CloudFormation.Stack> => {
  const {
    Stacks,
  } = await cloudformation.describeStacks({ StackName: stackId }).promise()

  return Stacks[0]
}

export const getStackOutputs = async ({ cloudformation, stackId }: StackInfoParams):Promise<AWS.CloudFormation.Output[]> => {
  const { Outputs } = await getStackInfo({ cloudformation, stackId })
  return Outputs
}

export const getMyCloudStackTables = async ({ cloudformation, stackId }: StackInfoParams) => {
  const outputs = await getStackOutputs({ cloudformation, stackId })
  return outputs.filter(o => o.OutputKey.endsWith('Table')).map(o => o.OutputValue)
}

export const getStackParameters = async (opts: StackInfoParams):Promise<AWS.CloudFormation.Parameter[]> => {
  const { Parameters } = await getStackInfo(opts)
  return Parameters

  // const [info, templateParams] = await Promise.all([
  //   getStackInfo(opts),
  //   getStackTemplateParameters(opts),
  // ])

  // return Object.keys(templateParams).map(ParameterKey => {
  //   const defined = info.Parameters.find(p => p.ParameterKey === ParameterKey)
  //   return {
  //     ParameterKey,
  //     ParameterValue: defined ? defined.ParameterValue : templateParams[ParameterKey].Default
  //   }
  // })
}

export const mergeParameters = (base: CFParameter[], more: CFParameter[]) => {
  const map:any = {}
  const set = (p: CFParameter) => {
    if (p.ParameterValue !== '') {
      map[p.ParameterKey] = p.ParameterValue
    }
  }

  base.forEach(p => map[p.ParameterKey] = p.ParameterValue)
  // overwrite
  more.forEach(p => map[p.ParameterKey] = p.ParameterValue)
  return _.transform(map, (result:CFParameter[], ParameterValue:string, ParameterKey:string) => {
    result.push({ ParameterKey, ParameterValue })
  }, [])
}

export const listOutputResources = async ({ cloudformation, stackId }: StackInfoParams):Promise<CloudResource[]> => {
  const outputs = await getStackOutputs({ cloudformation, stackId })
  return outputs.map(({ OutputKey, OutputValue }) => {
    const match = OutputKey.match(/(Bucket|Table|Key|LogGroup|RestApi)$/)
    if (match) {
      const type = match[1].toLowerCase() as CloudResourceType
      return { type, name: OutputKey, value: OutputValue }
    }
  })
  .filter(_.identity)
}

// export const listRetainedResources = async (cloudformation: AWS.CloudFormation, stackName):Promise<AWS.CloudFormation.StackResourceSummary[]> => {
//   const [template, resources] = await Promise.all([
//     getStackTemplate(cloudformation, stackName),
//     listStackResources(cloudformation, stackName),
//   ])

//   const retained = Object.keys(template.Resources)
//     .filter(logicalId => isRetained(template.Resources[logicalId]))
//     .map(logicalId => resources.find(r => r.LogicalResourceId === logicalId))
//     // some resources may be created conditionally (created or passed in parameters)
//     .filter(_.identity)

//   const nestedStacks = resources.filter(r => r.ResourceType === 'AWS::CloudFormation::Stack')
//   const nestedRetained = _.flatten(
//     await Promise.all(nestedStacks.map(r => listRetainedResources(cloudformation, r.PhysicalResourceId)))
//   )

//   return retained.concat(nestedRetained)
// }

export const listStackResources = async (
  cloudformation: AWS.CloudFormation,
  StackName: string,
  filter: StackResourceSummaryFilter=acceptAll
):Promise<AWS.CloudFormation.StackResourceSummary[]> => {
  let resources:AWS.CloudFormation.StackResourceSummary[] = []
  const opts:AWS.CloudFormation.ListStackResourcesInput = { StackName }
  while (true) {
    let {
      StackResourceSummaries,
      NextToken
    } = await cloudformation.listStackResources(opts).promise()

    resources = resources.concat(StackResourceSummaries.filter(filter))
    opts.NextToken = NextToken
    if (!opts.NextToken) break
  }

  return resources
}

export const listStackResourcesByType = (type, cloudformation: AWS.CloudFormation, stackName:string) => {
  return listStackResources(cloudformation, stackName, ({ ResourceType }) => type === ResourceType)
}

export const listStackResourceIdsByType = async (type, cloudformation: AWS.CloudFormation, stackName:string) => {
  const resources = await listStackResourcesByType(type, cloudformation, stackName)
  return resources.map(r => r.PhysicalResourceId)
}

export const listStackBuckets = (
  cloudformation: AWS.CloudFormation,
  stackName: string
) => listStackResourcesByType('AWS::S3::Bucket', cloudformation, stackName)

export const listStackBucketIds = (
  cloudformation: AWS.CloudFormation,
  stackName: string
) => listStackResourceIdsByType('AWS::S3::Bucket', cloudformation, stackName)

export const listStackFunctions = (
  cloudformation: AWS.CloudFormation,
  stackName: string
) => listStackResourcesByType('AWS::Lambda::Function', cloudformation, stackName)

export const listStackFunctionIds = (
  cloudformation: AWS.CloudFormation,
  stackName: string
) => listStackResourceIdsByType('AWS::Lambda::Function', cloudformation, stackName)

export const listStackTables = (
  cloudformation: AWS.CloudFormation,
  stackName: string
) => listStackResourcesByType('AWS::DynamoDB::Table', cloudformation, stackName)

export const listStackTableIds = (
  cloudformation: AWS.CloudFormation,
  stackName: string
) => listStackResourceIdsByType('AWS::DynamoDB::Table', cloudformation, stackName)

export const listSubstacks = (
  cloudformation: AWS.CloudFormation,
  stackName: string
) => listStackResourcesByType('AWS::CloudFormation::Stack', cloudformation, stackName)

export const listSubstackIds = (
  cloudformation: AWS.CloudFormation,
  stackName: string
) => listStackResourceIdsByType('AWS::CloudFormation::Stack', cloudformation, stackName)

export const destroyBucket = async (s3: AWS.S3, Bucket: string) => {
  await emptyBucket(s3, Bucket)
  try {
    await s3.deleteBucket({ Bucket }).promise()
  } catch (err) {
    ignoreNotFound(err)
  }
}

export const markBucketForDeletion = async (s3: AWS.S3, bucket: string) => {
  try {
    await setBucketExpirationDays({ s3, bucket, days: 1 })
  } catch (err) {
    ignoreNotFound(err)
    throw new CustomErrors.NotFound(`bucket: ${bucket}`)
  }
}

export const deleteTable = async ({ dynamodb, tableName }: {
  dynamodb: AWS.DynamoDB
  tableName: string
}) => {
  try {
    await dynamodb.deleteTable({ TableName: tableName }).promise()
  } catch (err) {
    ignoreNotFound(err)
    throw new CustomErrors.NotFound(`table not found: ${tableName}`)
  }
}

export const deleteKey = async ({ kms, keyId }: {
  kms: AWS.KMS
  keyId: string
}) => {
  try {
    await kms.disableKey({ KeyId: keyId }).promise()
  } catch (err) {
    Errors.ignore(err, /pending deletion/)
    throw new CustomErrors.NotFound(`key not found with id: ${keyId}`)
  }

  try {
    await kms.scheduleKeyDeletion({ KeyId: keyId }).promise()
  } catch (err) {
    Errors.ignore(err, /pending deletion/)
    throw new CustomErrors.NotFound(`key not found with id: ${keyId}`)
  }
}

export const deleteLogGroup = async ({ logs, name }: {
  logs: AWS.CloudWatchLogs
  name: string
}) => {
  try {
    await logs.deleteLogGroup({ logGroupName: name }).promise()
  } catch (err) {
    ignoreNotFound(err)
    throw new CustomErrors.NotFound(`log group with name: ${name}`)
  }
}

export const deleteRestApi = async ({ apigateway, apiId }: {
  apigateway: AWS.APIGateway
  apiId: string
}) => {
  try {
    await apigateway.deleteRestApi({ restApiId: apiId }).promise()
  } catch (err) {
    ignoreNotFound(err)
  }
}

export const getNotDeletedStack = async ({ cloudformation, stackId }: StackInfoParams) => {
  const { Stacks } = await cloudformation.describeStacks({ StackName: stackId }).promise()
  const notDeleted = Stacks.filter(s => s.StackStatus !== 'DELETE_COMPLETE')
  if (!notDeleted.length) {
    throw new CustomErrors.NotFound(`stack not found: ${stackId}`)
  }

  return notDeleted[0]
}

export const assertStackExistsAndIsNotDeleted = async (opts: StackInfoParams) => {
  // ignore return value
  await getNotDeletedStack(opts)
}

export const disableStackTerminationProtection = async ({ cloudformation, stackId }: StackInfoParams) => {
  await assertStackExistsAndIsNotDeleted({ cloudformation, stackId })
  return await cloudformation.updateTerminationProtection({
    StackName: stackId,
    EnableTerminationProtection: false,
  }).promise()
}

export const deleteStack = async ({ cloudformation, params }: DeleteStackOpts) => {
  const { StackName } = params
  await assertStackExistsAndIsNotDeleted({ cloudformation, stackId: params.StackName })

  while (true) {
    try {
      await cloudformation.deleteStack(params).promise()
      break
    } catch (err) {
      if (!err.message.includes('UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS')) {
        throw err
      }

      // back off, try again
      await exports.wait(5000)
    }
  }

  return async () => {
    await exports.wait(5000)
    await awaitStackDelete(cloudformation, params.StackName)
  }
}

export const createStackInRegion = async ({ region, params }: CreateStackInRegionOpts) => {
  return createStack({
    cloudformation: new AWS.CloudFormation({ region }),
    params,
  })
}

export const updateStackInRegion = async ({ region, params }: UpdateStackInRegionOpts) => {
  return updateStack({
    cloudformation: new AWS.CloudFormation({ region }),
    params,
  })
}

export const createStack = async ({ cloudformation, params }: CreateStackOpts) => {
  const { StackId } = await cloudformation.createStack(params).promise()
  return async () => {
    await exports.wait(5000)
    await awaitStackCreate(cloudformation, params.StackName)
    return StackId
  }
}

export const updateStack = async ({ cloudformation, params }: UpdateStackOpts) => {
  const { StackId } = await cloudformation.updateStack(params).promise()
  return async () => {
    await exports.wait(5000)
    await awaitStackUpdate(cloudformation, params.StackName)
    return StackId
  }
}

export const updateStackAndWait = (opts:UpdateStackOpts) => updateStack(opts).then(wait => wait())
export const updateStackInRegionAndWait = (opts:UpdateStackInRegionOpts) => updateStackInRegion(opts).then(wait => wait())
export const createStackAndWait = (opts:CreateStackOpts) => createStack(opts).then(wait => wait())
export const createStackInRegionAndWait = (opts:CreateStackInRegionOpts) => createStackInRegion(opts).then(wait => wait())
export const deleteStackAndWait = (opts:DeleteStackOpts) => deleteStack(opts).then(wait => wait())

const isUpdateableStatus = (status: AWS.CloudFormation.StackStatus) => {
  return status.endsWith('_COMPLETE') && !status.startsWith('DELETE_')
}

export const getStackId = async (cloudformation: AWS.CloudFormation, stackName: string):Promise<string> => {
  const stacks = await listStacks(
    cloudformation,
    ({ StackName, StackStatus }) => StackName === stackName && isUpdateableStatus(StackStatus)
  )

  return stacks[0] && stacks[0].id
}

export const getStackTemplateParameters = async ({ cloudformation, stackId }: StackInfoParams): Promise<CFParameterDefMap> => {
  const template = await getStackTemplate({ cloudformation, stackId })
  return template.Parameters || {}
}

export const getReuseParameters = async ({ cloudformation, stackId }: StackInfoParams): Promise<CFParameter[]> => {
  const parameters = await getStackTemplateParameters({ cloudformation, stackId })
  return Object.keys(parameters).map(p => ({
    ParameterKey: p,
    UsePreviousValue: true,
  }))
}

export const getStackTemplate = async ({ cloudformation, stackId }: StackInfoParams):Promise<CFTemplate> => {
  const { TemplateBody } = await cloudformation.getTemplate({
    StackName: stackId
  }).promise()

  if (TemplateBody.trim().startsWith('{')) {
    return JSON.parse(TemplateBody)
  }

  return YAML.safeLoad(TemplateBody)
}

// export const createOrUpdateStack = async (aws: AWS, params: AWS.CloudFormation.UpdateStackInput) => {
//   const StackId = await getStackId(aws, params.StackName)
//   if (StackId) {
//     await updateStack(aws, params)
//   } else {
//     await createStack(aws, params)
//   }
// }

export const awaitStackCreate = async (cloudformation: AWS.CloudFormation, stackName:string) => {
  return waitFor({ cloudformation, event: 'stackCreateComplete', stackName })
}

export const awaitStackDelete = async (cloudformation: AWS.CloudFormation, stackName:string) => {
  return waitFor({ cloudformation, event: 'stackDeleteComplete', stackName })
}

export const awaitStackUpdate = async (cloudformation: AWS.CloudFormation, stackName:string) => {
  return waitFor({ cloudformation, event: 'stackUpdateComplete', stackName })
}

export const waitFor = async ({ cloudformation, stackName, event }: {
  cloudformation: AWS.CloudFormation
  stackName: string
  event: 'stackCreateComplete' | 'stackUpdateComplete' | 'stackDeleteComplete'
}) => {
  try {
    // @ts-ignore
    return await cloudformation.waitFor(event, { StackName: stackName }).promise()
  } catch (err) {
    const url = getConsoleLinkForStacksInRegion({ region: cloudformation.config.region, status: 'failed' })
    throw new CustomErrors.ServerError(`operation may have failed. Check your stacks here: ${url}`)
  }
}

type FilterStackSummary = (item: AWS.CloudFormation.StackSummary) => boolean

export const listStacks = async (cloudformation: AWS.CloudFormation, filter:FilterStackSummary=acceptAll) => {
  const listStacksOpts:AWS.CloudFormation.ListStacksInput = {
    StackStatusFilter: ['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE']
  }

  let stackInfos = []
  let keepGoing = true
  while (keepGoing) {
    let {
      NextToken,
      StackSummaries
    } = await cloudformation.listStacks(listStacksOpts).promise()

    stackInfos = stackInfos.concat(StackSummaries.filter(filter).map(({ StackId, StackName }) => ({
      id: StackId,
      name: StackName
    })))

    listStacksOpts.NextToken = NextToken
    keepGoing = !!NextToken
  }

  return stackInfos
}

// export const deleteAutoScalingTargets = async (aws: AWS, StackName: string) => {
//   let params: _AWS.ApplicationAutoScaling.DescribeScalableTargetsRequest = {
//     ServiceNamespace: 'dynamodb'
//   }

//   let targets:_AWS.ApplicationAutoScaling.ScalableTarget[] = []
//   let batch:_AWS.ApplicationAutoScaling.DescribeScalableTargetsResponse
//   do {
//     batch = await aws.applicationAutoScaling.describeScalableTargets(params).promise()
//     targets = targets.concat(batch.ScalableTargets)
//   } while (batch.NextToken)

//   const prefix = `table/${StackName}-`
//   const targetsForStack = targets.filter(target => target.ResourceId.startsWith(prefix))
//   if (!targetsForStack) return

//   await Promise.all(targetsForStack.map(async ({ ResourceId, ServiceNamespace, ScalableDimension }) => {
//     await aws.applicationAutoScaling.deregisterScalableTarget({
//       ResourceId,
//       ServiceNamespace,
//       ScalableDimension,
//     }).promise()
//   }))
// }

export const getApiBaseUrl = async (cloudformation: AWS.CloudFormation, StackName:string) => {
  const result = await cloudformation.describeStacks({ StackName }).promise()
  const { Outputs } = result.Stacks[0]
  const endpoint = Outputs.find(x => /^ServiceEndpoint/.test(x.OutputKey))
  return endpoint.OutputValue
}

export const splitCamelCase = (str: string) => str.split(/(?=[A-Z])/g)
export const splitCamelCaseToString = (str: string, delimiter: string=' ') => splitCamelCase(str).join(delimiter)
export const checkCommandInPath = cmd => {
  const { code } = shelljs.exec(`command -v ${cmd}`)
  if (code !== 0) {
    throw new CustomErrors.InvalidEnvironment(`Please install: ${cmd}`)
  }
}

export const wait = millis => new Promise(resolve => setTimeout(resolve, millis))
export const normalizeNodeFlags = flags => {
  if (!(flags.inspect || flags['inspect-brk'] || flags.debug || flags['debug-brk'])) return

  const nodeVersion = Number(process.version.slice(1, 2))
  if (nodeVersion >= 8) {
    if (flags.debug) {
      delete flags.debug
      flags.inspect = true
    }

    if (flags['debug-brk']) {
      delete flags['debug-brk']
      flags['inspect-brk'] = true
    }
  } else {
    if (flags.debug || flags['debug-brk']) {
      flags.inspect = true
    }
  }
}

export const pickNonNull = obj => _.pickBy(obj, val => val != null)

const sha256 = (str: string, enc: crypto.HexBase64Latin1Encoding = 'hex') => {
  return crypto.createHash('sha256').update(str).digest(enc)
}

const shortenString = (str: string, maxLength: number) => {
  const tooLongBy = str.length - maxLength
  if (tooLongBy <= 0) return str

  if (str.length < 6) throw new Error(`string is too short: ${str}`)

  return str.slice(0, maxLength - 6) + sha256(str).slice(0, 6)
}

const parseMyCloudStackName = (name: string) => {
  const [shortName, stage] = name.match(MY_CLOUD_STACK_NAME_REGEX).slice(1)
  return {
    shortName,
    stage,
  }
}

export const isMyCloudStackName = (name: string) => MY_CLOUD_STACK_NAME_REGEX.test(name)
export const validateNewMyCloudStackName = (name: string) => {
  if (!MY_CLOUD_STACK_NAME_STRICTER_REGEX.test(name)) {
    throw new CustomErrors.InvalidInput(`"newStackName" must adhere to regex: ${MY_CLOUD_STACK_NAME_STRICTER_REGEX}`)
  }
}

export const getServicesStackName = (stackName: string) => {
  const { shortName } = parseMyCloudStackName(stackName)
  const shorterName = shortenString(shortName, 14)
  return `${shorterName}-srvcs` // max length 20 chars
}

export const canAccessECRRepos = async (ecr: AWS.ECR, { accountId, repoNames }: {
  accountId: string,
  repoNames: string[]
}) => {
  try {
    await ecr.describeRepositories({
      registryId: accountId,
      repositoryNames: repoNames
    }).promise()

    return true
  } catch (err) {
    if (err.name === 'AccessDeniedException') {
      return false
    }

    throw err
  }
}

export const doKeyPairsExist = async (ec2: AWS.EC2, names: string[]) => {
  const params: AWS.EC2.DescribeKeyPairsRequest = {
    KeyNames: names
  }

  try {
    await ec2.describeKeyPairs(params).promise()
    return true
  } catch (err) {
    return false
  }
}

export const listKeyPairs = async (ec2: AWS.EC2) => {
  const { KeyPairs } = await ec2.describeKeyPairs().promise()
  return KeyPairs.map(k => k.KeyName)
}

// export const listRegions = async (aws: AWS) => {
//   const { Regions } = await aws.ec2.describeRegions().promise()
//   return Regions.map(r => r.RegionName)
// }

export const listAZs = async ({ region }) => {
  const ec2 = new AWS.EC2({ region })
  const { AvailabilityZones } = await ec2.describeAvailabilityZones({
    Filters: [
      {
        Name: 'region-name',
        Values: [region]
      }
    ]
  }).promise()

  return AvailabilityZones
    .filter(a => a.RegionName === region)
    .map(a => a.ZoneName)
}

export const getUsedEIPCount = async (ec2: AWS.EC2) => {
  const { Addresses } = await ec2.describeAddresses().promise()
  return Addresses.length
}

export const getConsoleLinkForStacksInRegion = ({ region, status='active' }) => {
  return `https://${region}.console.aws.amazon.com/cloudformation/home?region=${region}#/stacks?filter=${status}`
}

export const updateEnvironments = async (lambda: AWS.Lambda, { functions, transform }: {
  functions: string[]
  transform: ({ name: string, env: any }) => any
}) => {
  const confs = await Promise.all(functions.map(FunctionName => lambda.getFunctionConfiguration({ FunctionName }).promise()))
  await Promise.all(functions.map(async (FunctionName, i) => {
    const conf = confs[i]
    const Variables = transform({
      name: FunctionName,
      env: conf.Environment.Variables
    })

    await lambda.updateFunctionConfiguration({
      FunctionName,
      Environment: { Variables }
    }).promise()
  }))
}

export const xor = (...args) => args.reduce((acc, next) => {
  return (acc || next) && !(acc && next)
}, false)

const isLocal = ({ local, remote, project }: ConfOpts) => {
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

    return true
  }

  if (typeof remote === 'boolean') {
    return !remote
  }

  return !!project
}

export const normalizeConfOpts = (opts: ConfOpts):ConfOpts => {
  const local = isLocal(opts)
  return {
    ...opts,
    local,
    remote: !local,
  }
}

export const isRemoteOnlyCommand = commandName => REMOTE_ONLY_COMMANDS.includes(commandName)
export const isSafeRemoteCommand = commandName => SAFE_REMOTE_COMMANDS.includes(commandName)

export const createQRCode = (...args) => {
  const QRCode = require('qrcode')
  const toFile = promisify(QRCode.toFile.bind(QRCode))
  return toFile(...args)
}

const normalizeError = err => {
  if (err instanceof Error) return err

  const { name, message='unspecified' } = err
  let normalized
  if (name && name in global) {
    const ctor = global[name]
    try {
      normalized = new ctor(name)
    } catch (err) {}
  }

  if (!normalized) {
    normalized = new Error(message)
  }

  _.extend(normalized, err)
  return normalized
  // return new Error(JSON.stringify(err))
}

export const unwrapReturnValue = ret => {
  const { error, result } = ret
  if (error) {
    return {
      ...ret,
      error: normalizeError(error),
    }
  }

  if (result) {
    if (result.error || result.result) {
      return unwrapReturnValue(result)
    }
  }

  return ret
}

type Promiser<T> = (item:T) => Promise<void|any>

export const series = async <T>(arr:T[], exec:Promiser<T>) => {
  for (const item of arr) {
    await exec(item)
  }
}

type PrimitiveType = 'string'|'number'|'object'|'boolean'|'undefined'

interface AttrTypeMap {
  [attr: string]: PrimitiveType
}

export const requireOption = (obj: any, option: string, type: PrimitiveType) => {
  if (typeof obj[option] !== type) {
    throw new CustomErrors.InvalidInput(`expected ${type} "${option}"`)
  }
}

export const requireOptions = (obj: any, typeMap: AttrTypeMap) => {
  for (let opt in typeMap) {
    requireOption(obj, opt, typeMap[opt])
  }
}

export const parseStackArn = (arn: string) => {
  // arn:aws:cloudformation:us-east-1:123456789012:stack/stack-name/d8d99a40-c13f-11e8-a6d8-50d5cd1ea8d2
  const [
    region,
    accountId,
    more,
  ] = arn.split(':').slice(3)

  const [
    stackName,
    id,
  ] = more.split('/').slice(1)

  return { region, accountId, stackName }
}

export const splitOnCharAtIdx = (str: string, idx: number) => {
  return [
    str.slice(0, idx),
    str.slice(idx + 1),
  ]
}

const capFirst = (str: string) => str[0].toUpperCase() + str.slice(1)

export const toCamelCase = (str: string, delimiter: string=' ') => {
  return str.split(delimiter)
    .filter(_.identity)
    .map((part, i) => i === 0 ? part : capFirst(part))
    .join('')
}

const createClientOpts = ({ profile, region }: ClientOpts) => {
  const opts:any = {}
  if (region) {
    opts.region = region
  }

  if (profile) {
    opts.credentials = new AWS.SharedIniFileCredentials({ profile })
  }

  return opts
}

export const createCloudFormationClient = (opts: ClientOpts) => new AWS.CloudFormation(createClientOpts(opts))
export const createDynamoDBClient = (opts: ClientOpts) => new AWS.DynamoDB(createClientOpts(opts))
export const createS3Client = (opts: ClientOpts) => new AWS.S3(createClientOpts(opts))

export const execWithListr = async ({ title, fn }) => {
  let result
  await new Listr([
    {
      title,
      task: async () => {
        result = await fn()
      },
    }
  ]).run()

  return result
}

export const validateISODate = (dateString: string) => {
  const date = new Date(dateString)
  let expectedString
  try {
    expectedString = date.toISOString()
  } catch (err) {}

  if (expectedString !== dateString) {
    throw new CustomErrors.InvalidInput(`expected iso date, e.g. ${new Date('2000-11-30').toISOString()} ?`)
  }
}

const ALPHA_NUMERIC = 'abcdefghijklmnopqrstuvwxyz0123456789'

// not necessarily secure
export const randomAlphaNumericString = (length: number) => {
  const bytes = crypto.randomBytes(length)
  const letters = [].slice.call(bytes).map(b => ALPHA_NUMERIC[b % ALPHA_NUMERIC.length])
  return letters.join('')
}

export const doesResourceExist = async ({ client, resource }: {
  client: AWSClients
  resource: CloudResource
}) => {
  const { type, name, value } = resource
  switch (type) {
    case 'bucket':
      return doesBucketExist({ s3: client.s3, bucket: value })
    case 'key':
      return doesKeyExist({ kms: client.kms, keyId: value })
    case 'table':
      return doesTableExist({ dynamodb: client.dynamodb, table: value })
    case 'loggroup':
      return doesLogGroupExist({ logs: client.logs, name: value })
    case 'restapi':
      return doesApiGatewayRestApiExist({ apigateway: client.apigateway, apiId: value })
    default:
      throw new CustomErrors.InvalidInput(`unimplemented existence check for resource type: ${type}`)
  }
}

export const doesBucketExist = async ({ s3, bucket }: {
  s3: AWS.S3
  bucket: string
}) => {
  try {
    await s3.headBucket({ Bucket: bucket }).promise()
    return true
  } catch (err) {
    return false
  }
}

export const doesTableExist = async ({ dynamodb, table }: {
  dynamodb: AWS.DynamoDB
  table: string
}) => {
  try {
    await dynamodb.describeTable({ TableName: table }).promise()
    return true
  } catch (err) {
    ignoreNotFound(err)
    return false
  }
}

export const doesLogGroupExist = async ({ logs, name }: {
  logs: AWS.CloudWatchLogs
  name: string
}) => {
  try {
    await logs.describeLogStreams({ logGroupName: name }).promise()
    return true
  } catch (err) {
    ignoreNotFound(err)
    return false
  }
}

export const doesApiGatewayRestApiExist = async ({ apigateway, apiId }: {
  apigateway: AWS.APIGateway
  apiId: string
}) => {
  try {
    await apigateway.getRestApi({ restApiId: apiId }).promise()
    return true
  } catch (err) {
    ignoreNotFound(err)
    return false
  }
}

export const doesKeyExist = async ({ kms, keyId }: {
  kms: AWS.KMS
  keyId: string
}) => {
  try {
    const { KeyMetadata } = await kms.describeKey({ KeyId: keyId }).promise()
    return !KeyMetadata.DeletionDate
  } catch (err) {
    ignoreNotFound(err)
    return false
  }
}

export const getLockedParameterValues = ({ Parameters }: CFTemplate) => {
  return _.transform(Parameters, (result, { AllowedValues=[] }:CFParameterDef, key:string) => {
    if (AllowedValues.length === 1) {
      result[key] = AllowedValues[0]
    }
  }, {})
}

export const lockImmutableParameters = ({ template, parameters }: {
  template: CFTemplate
  parameters: CFParameter[]
}) => {
  const locked:any = getLockedParameterValues(template)
  parameters.forEach(p => {
    const key = p.ParameterKey
    const value = p.ParameterValue
    if (key in locked && value !== locked[key]) {
      logger.debug(`locking parameter: ${key}`)
      p.ParameterValue = locked[key]
    }
  })
}

export const getMissingParameters = ({ template, parameters }):CFParameterDef[] => {
  return _.transform(template.Parameters, (result: CFParameterDef[], value: CFParameterDef, key: string) => {
    if (!('Default' in value)) {
      if (!parameters.some(p => p.ParameterKey === key)) {
        result.push({ ...value, Name: key })
      }
    }
  }, [])
}

export const getParameterDescription = ({ Name, Label, Description }: CFParameterDef) => {
  return Description || Label || splitCamelCaseToString(Name)
}

export const getRestApiRootResourceId = async ({ apigateway, apiId }: {
  apigateway: AWS.APIGateway
  apiId: string
}) => {
  const { items } = await apigateway.getResources({ restApiId: apiId }).promise()
  return items.find(i => i.path === '/').id
}

export const s3HeadObject = async ({ s3, bucket, key }: S3ObjectOpBaseOpts) => {
  try {
    return await s3.headObject({ Bucket: bucket, Key: key }).promise()
  } catch (err) {
    ignoreNotFound(err)
    throw new CustomErrors.NotFound(`object not found. bucket: ${bucket}, key: ${key}`)
  }
}

export const doesS3ObjectExist = async (opts: S3ObjectOpBaseOpts) => {
  try {
    await s3HeadObject(opts)
    return true
  } catch (err) {
    Errors.ignore(err, CustomErrors.NotFound)
    return false
  }
}

export const assertS3ObjectExists = s3HeadObject

const reverseString = (str: string) => str.split('').reverse().join('')
export const sortParameters = (params: CFParameter[]) => _.sortBy(params, p => reverseString(p.ParameterKey))

export const getBucketEncryptionKey = async ({ s3, kms, bucket }: S3EncOpBaseOpts) => {
  let ServerSideEncryptionConfiguration
  try {
    ({ ServerSideEncryptionConfiguration } = await s3.getBucketEncryption({ Bucket: bucket }).promise())
  } catch (err) {
    Errors.ignore(err, { code: 'ServerSideEncryptionConfigurationNotFoundError' })
    return
  }

  if (!ServerSideEncryptionConfiguration) return

  const { Rules = [] } = ServerSideEncryptionConfiguration
  if (!Rules.length) return

  const kmsRule = Rules.find(r => !!r.ApplyServerSideEncryptionByDefault.KMSMasterKeyID)
  if (!kmsRule) return

  const id = kmsRule.ApplyServerSideEncryptionByDefault.KMSMasterKeyID
  if (id.startsWith('key/')) {
    return id
  }

  const { KeyMetadata } = await kms.describeKey({ KeyId: id }).promise()
  return `key/${KeyMetadata.KeyId}`
}

export const setBucketExpirationDays = async ({ s3, bucket, days }: S3SetBucketExpirationOpts) => {
  return await setBucketLifeCycleRule({
    s3,
    bucket,
    filter: r => r.Filter.Prefix === '' && !!r.Expiration,
    update: r => {
      r.Expiration.Days = days
      r.NoncurrentVersionExpiration.NoncurrentDays = days
    },
    create: ():AWS.S3.LifecycleRule => ({
      ID: 'bucket-level-expiration',
      Status: 'Enabled',
      Filter: {
        Prefix: '',
      },
      Expiration: {
        Days: days
      },
      NoncurrentVersionExpiration: {
        NoncurrentDays: days
      }
    })
  })
}

export const setBucketLifeCycleRule = async ({ s3, bucket, filter, create }: S3SetBucketLifeCycleRuleOpts) => {
  let Rules
  try {
    ({ Rules } = await s3.getBucketLifecycleConfiguration({ Bucket: bucket }).promise())
  } catch (err) {
    ignoreNotFound(err)
    Rules = []
  }

  let rule = Rules.find(filter)
  if (!rule) {
    rule = {} as AWS.S3.LifecycleRule
    Rules.push(rule)
  }

  _.merge(rule, create())
  await s3.putBucketLifecycleConfiguration({
    Bucket: bucket,
    LifecycleConfiguration: { Rules }
  }).promise()
}

export const setBucketTransitionToGlacier = async ({ s3, bucket, days }: S3SetBucketTransitionOpts) => {
  return await setBucketLifeCycleRule({
    s3,
    bucket,
    filter: r => r.Filter.Prefix === '' &&
      r.Transitions &&
      r.Transitions.some(t => t.StorageClass === 'GLACIER'),
    update: r => {
      r.Transitions.find(r => r.StorageClass === 'GLACIER').Days = days
    },
    create: () => ({
      Status: 'Enabled',
      Filter: {
        Prefix: ''
      },
      Transitions: [
        {
          StorageClass: 'GLACIER',
          Days: days,
        }
      ],
    })
  })
}

export const describeTable = async ({ dynamodb, tableName }: TableParams) => {
  const { Table } = await dynamodb.describeTable({ TableName: tableName }).promise()
  return Table
}

export const setTableBillingMode = async ({ dynamodb, tableName, billingMode }: SetTableBillingModeParams) => {
  const info = await describeTable({ dynamodb, tableName })
  const currentBillingMode = info.BillingModeSummary ? info.BillingModeSummary.BillingMode : 'PROVISIONED'
  if (currentBillingMode === billingMode) return

  const ProvisionedThroughput = {
    ReadCapacityUnits: 10,
    WriteCapacityUnits: 10,
  }

  const params:AWS.DynamoDB.UpdateTableInput = {
    TableName: tableName,
    BillingMode: billingMode,
  }

  if (billingMode === 'PROVISIONED') {
    const { GlobalSecondaryIndexes=[] } = info
    if (GlobalSecondaryIndexes.length) {
      params.GlobalSecondaryIndexUpdates = GlobalSecondaryIndexes.map(i => ({
        Update: {
          IndexName: i.IndexName,
          ProvisionedThroughput,
        }
      } as AWS.DynamoDB.GlobalSecondaryIndexUpdate))
    }

    params.ProvisionedThroughput = ProvisionedThroughput
  }

  await dynamodb.updateTable(params).promise()
}

export const paramsToObject = (params: CFParameter[]) => params.reduce((obj, { ParameterKey, ParameterValue }) => {
  obj[ParameterKey] = ParameterValue
  return obj
}, {})
