import _ from 'lodash'
import inquirer from 'inquirer'
import AWS from 'aws-sdk'
import Listr from 'listr'
import tmp from 'tmp'
import promiseRetry from 'promise-retry'
// import { toSortableTag, sortTags, compareTags } from 'lexicographic-semver'
import Errors from '@tradle/errors'
import {
  Conf,
  AWSClients,
  PointInTime,
  Logger,
  CloudResource,
  CloudResourceType,
  CFTemplate,
  CFParameter,
  CFParameterDef,
  ClientOpts,
  // RestoreTableCliOpts,
} from './types'

import { Errors as CustomErrors } from './errors'
import { logger } from './logger'
import { confirmOrAbort, ask, chooseRegion } from './prompts'
import { create as wrapDynamoDB } from './dynamodb'
import { create as wrapS3 } from './s3'
import * as utils from './utils'
import { IMMUTABLE_STACK_PARAMETERS } from './constants'

const IS_RESTORABLE = {
  table: true,
  bucket: true,
}

const shouldRestoreBucket = ({ name }: CloudResource) => name !== 'LogsBucket' && name !== 'SourceDeploymentBucket'
const shouldRestoreTable = (output: CloudResource) => true

// const isBucket = (output: AWS.CloudFormation.Output) => output.OutputKey.endsWith('Bucket')
// const isTable = (output: AWS.CloudFormation.Output) => output.OutputKey.endsWith('Table')
// const validateSuffix = (input: string) => /^[a-z]{1-6}$/.test(input)

const RESTORED_RESOURCE_NAME_REGEX = /-r(\d+)$/

interface StackResource extends CloudResource {
  stackName: string
}

export const deriveRestoredResourceName = ({ stackName, type, name, value }: StackResource) => {
  let prevCount = 0
  const restoredMatch = value.match(RESTORED_RESOURCE_NAME_REGEX)
  if (restoredMatch) {
    prevCount = parseInt(restoredMatch[1])
  }

  let baseName = `${stackName}-${name}`.toLowerCase()
  if (baseName.endsWith(type)) {
    baseName = baseName.slice(0, -type.length)
  }

  if (type === 'bucket') {
    const rand = utils.randomAlphaNumericString(6)
    baseName = `${baseName}-${rand}`
  }

  // adhere to RESTORED_RESOURCE_NAME_REGEX
  return `${baseName}-r${(prevCount + 1)}`
}

interface RestoreResourcesOpts extends ClientOpts {
  client: AWSClients
  sourceStackArn: string
  date: PointInTime
}

export const restoreResources = async (opts: RestoreResourcesOpts) => {
  const { client, region, profile, sourceStackArn, date } = opts
  utils.validateISODate(date)

  const { stackName } = utils.parseStackArn(sourceStackArn)
  const { cloudformation } = client
  const dynamodb = wrapDynamoDB(client.dynamodb)
  const s3 = wrapS3(client.s3)

  // const suffix = await ask('enter a short suffix to append to restored tables. Use lowercase letters only.', validateSuffix)
  const getBaseParams = deriveParametersFromStack({ client, stackId: sourceStackArn })
  const getOutputs = utils.listOutputResources({ cloudformation, stackId: sourceStackArn })
  const parameters = await getBaseParams
  const outputs = (await getOutputs).filter(o => IS_RESTORABLE[o.type])

  outputs.forEach((o, i) => {
    const param = parameters.find(p => p.ParameterValue === o.value)
    if (!param) {
      throw new CustomErrors.NotFound(`expected parameter corresponding to output ${o.name}`)
    }
  })

  const buckets = outputs.filter(o => o.type === 'bucket' && shouldRestoreBucket(o))
  const oldBucketIds = buckets.map(b => b.value)
  const tables = outputs.filter(o => o.type === 'table' && shouldRestoreTable(o))
  const oldTableNames = tables.map(t => t.value)

  const getRestoredResourceName = (resource: CloudResource) => deriveRestoredResourceName({ stackName, ...resource })
  const restoreBucketsOpts = buckets.map(source => ({
    sourceName: source.value,
    destName: getRestoredResourceName(source),
    date,
    profile,
  }))

  const restoreTablesOpts = tables.map(table => ({
    sourceName: table.value,
    destName: getRestoredResourceName(table),
    date,
  }))

  await Promise.all([
    Promise.all(restoreTablesOpts.map(opts => dynamodb.assertCanRestoreTable(opts))),
    Promise.all(restoreBucketsOpts.map(opts => s3.assertCanRestoreBucket(opts)))
  ])

  logger.warn(`This will take a while. Do NOT interrupt me!`)

  const streams = {}
  const tableTasks = restoreTablesOpts.map((opts, i) => {
    const { sourceName, destName } = opts
    return {
      title: `${sourceName} -> ${destName}`,
      task: async () => {
        const { table, stream } = await dynamodb.restoreTable(opts)
        streams[destName] = stream
      }
    }
  })

  const bucketTasks = restoreBucketsOpts.map(opts => {
    const { sourceName, destName } = opts
    return {
      title: `${sourceName} -> ${destName}`,
      task: () => s3.restoreBucket(opts)
    }
  })

  await new Listr(tableTasks.concat(bucketTasks), { concurrent: true }).run()

  // const promiseRestoreTables = Promise.all(tables.map((source, i) => dynamodb.restoreTable({
  //   date,
  //   sourceName: source.value,
  //   destName: newTableNames[i],
  // })))

  // const promiseRestoreBuckets = Promise.all(oldBucketIds.map((source, i) => s3.restoreBucket({
  //   date,
  //   source,
  //   dest: newBucketIds[i],
  //   profile,
  // })))

  // await Promise.all([promiseRestoreBuckets, promiseRestoreTables])

  const old = tables.concat(buckets).map(r => r.value)
  const restored = _.map(restoreTablesOpts.concat(restoreBucketsOpts), 'destName')
  let [irreplaceable, replaceable] = _.partition(parameters, p => p.ParameterKey === 'SourceDeploymentBucket')
  old.forEach((oldPhysicalId, i) => {
    const newPhysicalId = restored[i]
    const param = replaceable.find(p => p.ParameterValue === oldPhysicalId)
    param.ParameterValue = newPhysicalId
    const stream = streams[newPhysicalId]
    if (!stream) return

    const streamParam = replaceable.find(p => p.ParameterValue.includes(`table/${oldPhysicalId}/stream`))
    if (streamParam) {
      streamParam.ParameterValue = stream
    } else {
      logger.warn(`relevant parameter not found for stream ${stream} (table ${newPhysicalId})`)
    }
  })

  irreplaceable = irreplaceable.map(r => ({
    ParameterKey: r.ParameterKey,
    UsePreviousValue: true,
  }))

  return irreplaceable.concat(replaceable)
}

// export const createStack = async ({ client, sourceStackArn, templateUrl, buckets, tables, immutableParameters=[], logger }: {
//   client: AWSClients
//   sourceStackArn: string
//   templateUrl: string
//   logger: Logger
//   buckets?: string[]
//   tables?: string[]
//   immutableParameters?: string[]
// }) => {
//   const template = utils.getStackTemplate({ cloudformation: client.cloudformation, stackId: sourceStackArn })
//   // const template = await utils.get(templateUrl)
//   const groups = groupParameters(template)
//   const values = {}
//   await utils.series(groups, async ({ name, parameters }) => {
//     parameters = parameters.filter(p => !immutableParameters.includes(p.Name))
//     if (!parameters.length) return

//     logger.info(name)
//     await utils.series(parameters, async ({ Name, Label, Description }) => {
//       const message = Description ? `${Label}: ${Description}` : Label
//       values[Name] = await ask(message)
//     })
//   })
// }

const OUTPUT_NAME_TO_PARAM = {
  // buckets
  ObjectsBucket: 'ExistingObjectsBucket',
  SecretsBucket: 'ExistingSecretsBucket',
  PrivateConfBucket: 'ExistingPrivateConfBucket',
  FileUploadBucket: 'ExistingFileUploadBucket',
  LogsBucket: 'ExistingLogsBucket',
  DeploymentBucket: 'ExistingDeploymentBucket',
  // ServerlessDeploymentBucket: 'ExistingDeploymentBucket',
  // tables
  EventsTable: 'ExistingEventsTable',
  Bucket0Table: 'ExistingBucket0Table',
  // streams
  Bucket0TableStream: 'ExistingBucket0TableStreamArn',
  // keys
  EncryptionKey: 'ExistingEncryptionKey',
  BucketEncryptionKey: 'ExistingBucketEncryptionKey',
  // api gateway
  ApiGatewayRestApi: 'ExistingApiGatewayRestApi',
  ApiGatewayRestApiRootResourceId: 'ExistingApiGatewayRestApiRootResourceId',
}

const setImmutableParameters = (parameters: CFParameter[]) => {
  IMMUTABLE_STACK_PARAMETERS.forEach(name => {
    let old = parameters.find(p => p.ParameterKey === name)
    if (!old) {
      old = { ParameterKey: name }
      parameters.push(old)
    }

    delete old.ParameterValue
    old.UsePreviousValue = true
  })
}

const isNonEmptyParameter = ({ ParameterValue }: CFParameter) => ParameterValue !== ''

export const isOverwrite = (
  oldParameters: CFParameter[],
  newParam: CFParameter
) => {
  const { ParameterKey, ParameterValue } = newParam
  const oldParam = oldParameters.find(p => p.ParameterKey === ParameterKey)
  return oldParam && isNonEmptyParameter(oldParam)
}

export const deriveParametersFromStack = async ({ client, stackId }: {
  client: AWSClients
  stackId: string
}) => {
  const { cloudformation, apigateway } = client
  const oldStack = await utils.getStackInfo({ cloudformation, stackId })
  const oldParameters = oldStack.Parameters
  // if (!forCreate) {
  //   setImmutableParameters(oldParameters)
  // }

  const oldOutputs = oldStack.Outputs
  const newParameters: CFParameter[] = oldOutputs
    .filter(r => r.OutputKey in OUTPUT_NAME_TO_PARAM)
    .map(({ OutputKey, OutputValue }) => ({
      ParameterKey: OUTPUT_NAME_TO_PARAM[OutputKey],
      ParameterValue: OutputValue,
    }))
    // don't overwrite anything from old stack
    .filter(newParam => !isOverwrite(oldParameters, newParam))

  // not too efficient, but there's only 10-20 of them
  const remainingOld = oldParameters.filter(({ ParameterKey }) => !newParameters.find(p => p.ParameterKey === ParameterKey))
  // remainingOld.forEach(p => {
  //   // seems a bit safer this way
  //   delete p.ParameterValue
  //   p.UsePreviousValue = true
  // })

  const parameters = newParameters.concat(remainingOld)
  const restApi = newParameters.find(o => o.ParameterKey === 'ExistingApiGatewayRestApi')
  if (restApi) {
    const rootResourceId = oldOutputs.find(o => o.OutputKey === 'ApiGatewayRestApiRootResourceId')
    if (!rootResourceId) {
      const root = await utils.getRestApiRootResourceId({ apigateway, apiId: restApi.ParameterValue })
      parameters.push({
        ParameterKey: 'ExistingApiGateway',
        ParameterValue: root,
      })
    }
  }

  return utils.sortParameters(parameters)
}

// export const getTemplateAndParametersFromStack = async ({ cloudformation, stackId }: {
//   cloudformation: AWS.CloudFormation
//   stackId: string
// }) => {
//   const getTemplate = utils.getStackTemplate({ cloudformation, stackId })
//   const getParams = deriveParametersFromStack({ cloudformation, stackId })
//   const template = (await getTemplate) as CFTemplate
//   const parameters = (await getParams) as CFParameter[]
//   return { template, parameters }
// }

// export const restoreStackToTemplate = async (opts: {
//   client: AWSClients
//   sourceStackArn: string
//   newStackName: string
//   templateUrl: string
//   parameters?: CFParameter[]
//   profile?: string
// }) => {
//   utils.requireOptions(opts, {
//     client: 'object',
//     sourceStackArn: 'string',
//     newStackName: 'string',
//     templateUrl: 'string',
//   })

//   utils.validateNewMyCloudStackName(newStackName)
// }

// export const uploadTemplateToStackDeploymentBucket = async ({ client, stackArn, template }: {
//   client: AWSClients
//   stackArn: string
//   template: CFTemplate
// }) => {
//   await utils.getStackInfo({ cloudformation: client.cloudformation, stackId: stackArn })

//   const deploymentBucket = stackParameters.find(p => p.ParameterKey === 'ExistingDeploymentBucket')

//   s3PathToUploadTemplate = `${deploymentBucket.ParameterValue}/tmp/recovery-template-${Date.now()}.json`

//   logger.info(`uploading template to ${s3PathToUploadTemplate}`)
//   const s3 = utils.createS3Client({ region, profile })
//   const [Bucket, Key] = utils.splitOnCharAtIdx(s3PathToUploadTemplate, s3PathToUploadTemplate.indexOf('/'))
//   await s3.putObject({
//     Bucket,
//     Key,
//     Body: new Buffer(JSON.stringify(template)),
//     ACL: 'public-read',
//     ContentType: 'application/json',
//   }).promise()

//   return `https://${Bucket}.s3.amazonaws.com/${Key}`
// }

export const restoreStack = async (opts: {
  conf: Conf
  sourceStackArn: string
  newStackName: string
  templateUrl?: string
  // newStackRegion: string
  stackParameters?: CFParameter[]
}) => {
  utils.requireOption(opts, 'conf', 'object')
  utils.requireOption(opts, 'sourceStackArn', 'string')
  utils.requireOption(opts, 'newStackName', 'string')
  // if (opts.newStackRegion) {
  //   utils.requireOption(opts, 'newStackRegion', 'string')
  // }

  let {
    conf,
    sourceStackArn,
    newStackName,
    templateUrl,
    stackParameters,
  } = opts

  const { client, profile='default' } = conf
  utils.validateNewMyCloudStackName(newStackName)

  const { region } = utils.parseStackArn(sourceStackArn)
  const cloudformation = utils.createCloudFormationClient({ region, profile })
  const getOldTemplate = await utils.getStackTemplate({ cloudformation, stackId: sourceStackArn })
  const getNewTemplate = templateUrl ? utils.get(templateUrl) : getOldTemplate
  const [oldTemplate, template] = await Promise.all([getOldTemplate, getNewTemplate])
  if (!stackParameters) {
    stackParameters = await deriveParametersFromStack({ client, stackId: sourceStackArn })
  }

  const getMissing = utils.isV2Template(oldTemplate)
    // by default, it'll use the previously specified values
    ? Promise.resolve([])
    : promptMissingParameters({ conf, template, parameters: stackParameters })

  const missing = await getMissing
  stackParameters.push(...missing)
  stackParameters = utils.sortParameters(stackParameters)
  utils.lockImmutableParameters({ template, parameters: stackParameters })

  if (!templateUrl) {
    const deploymentBucket = stackParameters.find(p => p.ParameterKey === 'ExistingDeploymentBucket')
    const s3PathToUploadTemplate = `${deploymentBucket.ParameterValue}/tmp/recovery-template-${Date.now()}.json`

    logger.info(`uploading template to ${s3PathToUploadTemplate}`)
    const s3 = utils.createS3Client({ region, profile })
    const [Bucket, Key] = utils.splitOnCharAtIdx(s3PathToUploadTemplate, s3PathToUploadTemplate.indexOf('/'))
    await s3.putObject({
      Bucket,
      Key,
      Body: new Buffer(JSON.stringify(template)),
      ACL: 'public-read',
      ContentType: 'application/json',
    }).promise()

    templateUrl = `https://${Bucket}.s3.amazonaws.com/${Key}`
  }

  return createStack({
    stackName: newStackName,
    parameters: stackParameters,
    region,
    templateUrl,
    profile,
  })
}

export const validateParameters = async ({ dynamodb, parameters }: {
  dynamodb: AWS.DynamoDB
  parameters: CFParameter[]
}) => {
  const ddbHelper = wrapDynamoDB(dynamodb)
  const tables = parameters.filter(p => p.ParameterKey.startsWith('Existing') && p.ParameterKey.endsWith('Table'))
  const streams = parameters.filter(p => p.ParameterKey.startsWith('Existing') && p.ParameterKey.endsWith('StreamArn'))
  await Promise.all(tables.map(async (table, i) => {
    const stream = streams.find(s => s.ParameterKey.startsWith(table.ParameterKey))
    if (!stream) return

    await ddbHelper.ensureStreamMatchesTable({ tableArn: table.ParameterValue, streamArn: stream.ParameterValue })
  }))
}

export const createStack = async (opts: {
  stackName: string
  region: string
  parameters: CFParameter[]
  templateUrl: string
  notificationTopics?: string[]
  profile?: string
}) => {
  const { stackName, region, templateUrl, parameters, profile, notificationTopics } = opts
  const dynamodb = utils.createDynamoDBClient({ region, profile })
  await validateParameters({ dynamodb, parameters })

  const cloudformation = utils.createCloudFormationClient({ region, profile })

  logger.info('grab some patience, this will take a while (5-20 minutes)')
  return await utils.createStackAndWait({
    cloudformation,
    params: {
      StackName: stackName,
      Capabilities: ['CAPABILITY_NAMED_IAM'],
      TemplateURL: templateUrl,
      Parameters: parameters,
      DisableRollback: true,
      NotificationARNs: notificationTopics || [],
    },
  })
}

export const getPromptsForParameters = (parameters: CFParameterDef[]) => parameters.map(getPromptForParameter)

const createValidatorForParameter = (parameter: CFParameterDef) => {
  const {
    Type,
    AllowedPattern,
    MinValue=-Infinity,
    MaxValue=Infinity,
    MinLength=-Infinity,
    MaxLength=Infinity,
    ConstraintDescription,
  } = parameter

  if (AllowedPattern) {
    const regex = new RegExp(AllowedPattern)
    return result => {
      if (!regex.test(result)) {
        return ConstraintDescription || `must match pattern: ${AllowedPattern}`
      }
    }
  }

  if (Type === 'Number') {
    return result => {
      if (isNaN(result)) return false
      if (typeof result === 'string') {
        result = result.includes('.') ? parseFloat(result) : parseInt(result)
      }

      if (result < MinValue || result > MaxValue) {
        return ConstraintDescription || `value must be between ${MinValue} and ${MaxValue}`
      }

      return true
    }
  }

  return result => {
    if (result.length < MinLength || result.length > MaxLength) {
      return ConstraintDescription || `value length must be between ${MinValue} and ${MaxValue}`
    }

    return true
  }
}

export const getPromptForParameter = (parameter: CFParameterDef) => {
  const {
    Name,
    Label,
    Type,
    Description,
    AllowedValues,
    AllowedPattern,
    ConstraintDescription,
    MinValue,
    MaxValue,
    MinLength,
    MaxLength,
  } = parameter

  const base:any = {
    name: Name,
    message: utils.getParameterDescription(parameter),
    validate: createValidatorForParameter(parameter),
  }

  if (AllowedValues) {
    return {
      ...base,
      type: 'rawlist',
      pageSize: Infinity,
      choices: AllowedValues.map(value => ({
        name: value,
        value,
      })),
    }
  }

  if (AllowedPattern) {
    const regex = new RegExp(AllowedPattern)
    return {
      ...base,
      type: 'input',
    }
  }

  return {
    ...base,
    type: 'input',
  }
}

interface ParameterGroup {
  name?: string
  parameters: CFParameterDef[]
}

// const normalizeParameter = (parameter: Parameter):Parameter => {
//   const {
//     MinValue=-Infinity,
//     MaxValue=Infinity,
//     MinLength=-Infinity,
//     MaxLength=Infinity,
//   } = parameter

//   return {
//     ...parameter,
//     MinValue,
//     MaxValue,
//     MinLength,
//     MaxLength,
//   }
// }

const groupParameters = (template: any):ParameterGroup[] => {
  const { Parameters, Metadata } = template
  if (!Metadata) {
    const parameters = Object.keys(Parameters).map(name => ({
      Name: name,
      Label: utils.splitCamelCase(name),
      ...Parameters[name],
    })) as CFParameterDef[]

    return [{ parameters }]
  }

  const { ParameterGroups, ParameterLabels } = Metadata['AWS::CloudFormation::Interface']
  return ParameterGroups.map(group => ({
    name: group.Label.default,
    parameters: group.Parameters.map(name => ({
      Name: name,
      Label: ParameterLabels[name],
      ...Parameters[name],
    }))
  }))
}

export const promptParameters = async ({ template, parameters }: {
  template: CFTemplate
  parameters: CFParameterDef[]
}) => {
  const prompts = getPromptsForParameters(parameters)
  const answers:CFParameter[] = []
  for (const prompt of prompts) {
    const key = prompt.name
    const resp = await inquirer.prompt([prompt])
    const value = resp[key]
    answers.push({ ParameterKey: key, ParameterValue: value })
  }

  return answers
}

export const getBlanksForMissingParameters = ({ template, parameters }) => {
  const missing = utils.getMissingParameters({ template, parameters })
  return missing.map(m => ({
    ParameterKey: m.Name,
    ParameterValue: m.Default || '',
  }))
}

export const promptMissingParameters = async ({ conf, template, parameters }: {
  conf: Conf
  template: CFTemplate
  parameters: CFParameter[]
}) => {
  let org:any
  try {
    ({ org } = await conf.getEndpointInfo())
  } catch (err) {
    Errors.rethrow(err, 'developer')
  }

  let missing = utils.getMissingParameters({ template, parameters })
  const added:CFParameter[] = []
  if (org) {
    const orgName = missing.find(p => p.Name === 'OrgName')
    const orgDomain = missing.find(p => p.Name === 'OrgDomain')
    const orgLogo = missing.find(p => p.Name === 'OrgLogo')
    const added: CFParameter[] = []
    if (orgName) {
      added.push({
        ParameterKey: orgName.Name,
        ParameterValue: org.name,
      })
    }

    if (orgDomain) {
      added.push({
        ParameterKey: orgDomain.Name,
        ParameterValue: org.domain,
      })
    }

    if (orgLogo) {
      added.push({
        ParameterKey: orgLogo.Name,
        // doesn't matter for updates
        ParameterValue: '',
      })
    }
  }

  missing = utils.getMissingParameters({ template, parameters: parameters.concat(added) })
  const answers = await promptParameters({
    template,
    parameters: missing.map(parameter => ({
      ...parameter,
      Description: `please remind me: ${utils.getParameterDescription(parameter)}`
    }))
  })

  return utils.sortParameters(added.concat(answers))
}
