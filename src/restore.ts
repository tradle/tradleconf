import matches from 'lodash/matches'
import sortBy from 'lodash/sortBy'
import partition from 'lodash/partition'
import uniq from 'lodash/uniq'
import cloneDeep from 'lodash/cloneDeep'
import execa from 'execa'
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
  CFTemplate,
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

const shouldRestoreBucket = (output: CloudResource) => output.name !== 'LogsBucket'
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
  const getBaseParams = deriveParametersFromStack({ cloudformation, stackId: sourceStackArn })
  const getOutputs = utils.listOutputResources({ cloudformation, stackId: sourceStackArn })
  const parameters = await getBaseParams
  const outputs = await getOutputs

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
  const newBucketIds = buckets.map(getRestoredResourceName)
  const newTableNames = tables.map(getRestoredResourceName)

  const setupNewBucket = async ({ source, target }) => {
    await s3.createBucketOrAssertEmpty(target)
    await s3.copyBucketSettings({ source, target })
  }

  await Promise.all([
    Promise.all(oldTableNames.map(tableName => dynamodb.assertTableExists(tableName))),
    Promise.all(newTableNames.map(tableName => dynamodb.assertTableDoesNotExist(tableName))),
    Promise.all(oldBucketIds.map(id => s3.assertBucketExists(id))),
    Promise.all(newBucketIds.map((target, i) => setupNewBucket({ source: oldBucketIds[i], target }))),
  ])

  logger.info('\nrestoring buckets:\n')
  buckets.forEach((bucket, i) => logger.info(`${bucket.name} to ${newBucketIds[i]}`))

  logger.info('\nrestoring tables:\n')
  tables.forEach((table, i) => logger.info(`${table.name} to ${newTableNames[i]}`))

  logger.info(`\nthis will take a while. Don't interrupt me!\n`)

  const streams = {}
  const tableTasks = oldTableNames.map((sourceName, i) => {
    const destName = newTableNames[i]
    return {
      title: `${sourceName} -> ${destName}`,
      task: async () => {
        const { table, stream } = await dynamodb.restoreTable({
          date,
          sourceName,
          destName,
        })

        streams[destName] = stream
      }
    }
  })

  const bucketTasks = oldBucketIds.map((source, i) => ({
    title: `${source} -> ${newBucketIds[i]}`,
    task: async () => {
      await s3.restoreBucket({
        date,
        source,
        dest: newBucketIds[i],
        profile,
      })
    }
  }))

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
  const restored = newTableNames.concat(newBucketIds)
  const [irreplaceable, replaceable] = partition(parameters, p => p.ParameterKey === 'SourceDeploymentBucket')
  old.forEach((oldPhysicalId, i) => {
    const newPhysicalId = restored[i]
    const param = replaceable.find(p => p.ParameterValue === oldPhysicalId)
    param.ParameterValue = newPhysicalId
    const stream = streams[newPhysicalId]
    if (!stream) return

    const streamParam = replaceable.find(p => p.ParameterValue.includes(`table/${oldPhysicalId}/stream`))
    streamParam.ParameterValue = stream
  })

  return irreplaceable.concat(replaceable)
}

// export const enableKMSKeyForStack = async (opts: {
//   kms: AWS.KMS
//   keyId: string
//   accountId: string
//   stackName: string
//   region: string
// }) => {
//   utils.requireOption(opts, 'keyId', 'string')
//   utils.requireOption(opts, 'accountId', 'string')
//   utils.requireOption(opts, 'stackName', 'string')
//   utils.requireOption(opts, 'region', 'string')

//   const { kms, keyId, accountId, stackName, region } = opts
//   const lambdaRoleArn = `arn:aws:iam::${accountId}:role/${stackName}-${region}-lambdaRole`
//   const baseParams = { KeyId: keyId }
//   const PolicyName = 'default'
//   const { KeyMetadata } = await kms.describeKey(baseParams).promise()
//   const getPolicy = kms.getKeyPolicy({ ...baseParams, PolicyName }).promise()
//   if (KeyMetadata.DeletionDate) {
//     await kms.cancelKeyDeletion(baseParams).promise()
//   }

//   if (!KeyMetadata.Enabled) {
//     await kms.enableKey(baseParams).promise()
//   }

//   const { Policy } = await getPolicy
//   const currentPolicy = JSON.parse(Policy)
//   const updatedPolicy = addKeyUsers(removeInvalidIamArns(currentPolicy), [lambdaRoleArn])
//   await kms.putKeyPolicy({
//     ...baseParams,
//     PolicyName,
//     Policy: JSON.stringify(updatedPolicy),
//   }).promise()
// }

// const removeInvalidIamArns = (policy: any) => {
//   policy = cloneDeep(policy)
//   for (const permission of policy.Statement) {
//     const { Principal } = permission
//     let { AWS } = Principal
//     if (typeof AWS === 'string') {
//       AWS = [AWS]
//     }

//     Principal.AWS = AWS.filter(isValidIamArn)
//   }

//   return policy
// }

// const isValidIamArn = (arn: string) => arn.startsWith('arn:aws:iam::')

// const addKeyUsers = (policy: any, iamArns: string[]) => {
//   policy = cloneDeep(policy)
//   const permission = policy.Statement.find(item => {
//     const { Sid, Effect, Action } = item
//     if (Sid === 'allowUseKey') return true
//     if (Effect === 'Allow') {
//       return Action.includes('kms:Decrypt') && Action.includes('kms:GenerateDataKey')
//     }
//   })

//   const { Principal } = permission
//   Principal.AWS = uniq(iamArns.concat(Principal.AWS || []))
//   return policy
// }

export const createStack = async ({ client, sourceStackArn, templateUrl, buckets, tables, immutableParameters=[], logger }: {
  client: AWSClients
  sourceStackArn: string
  templateUrl: string
  logger: Logger
  buckets?: string[]
  tables?: string[]
  immutableParameters?: string[]
}) => {
  const template = utils.getStackTemplate({ cloudformation: client.cloudformation, stackId: sourceStackArn })
  // const template = await utils.get(templateUrl)
  const groups = groupParameters(template)
  const values = {}
  await utils.series(groups, async ({ name, parameters }) => {
    parameters = parameters.filter(p => !immutableParameters.includes(p.Name))
    if (!parameters.length) return

    logger.info(name)
    await utils.series(parameters, async ({ Name, Label, Description }) => {
      const message = Description ? `${Label}: ${Description}` : Label
      values[Name] = await ask(message)
    })
  })
}

const LOGICAL_ID_TO_PARAM = {
  // buckets
  ObjectsBucket: 'ExistingObjectsBucket',
  SecretsBucket: 'ExistingSecretsBucket',
  PrivateConfBucket: 'ExistingPrivateConfBucket',
  FileUploadBucket: 'ExistingFileUploadBucket',
  LogsBucket: 'ExistingLogsBucket',
  // special case
  // Deployment: 'ExistingDeploymentBucket',
  // ServerlessDeploymentBucket: 'ExistingDeploymentBucket',
  // tables
  EventsTable: 'ExistingEventsTable',
  Bucket0Table: 'ExistingBucket0Table',
  // keys
  EncryptionKey: 'ExistingEncryptionKey',
}

const setImmutableParameters = (parameters: AWS.CloudFormation.Parameter[]) => {
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

export const deriveParametersFromStack = async ({ cloudformation, stackId }: {
  cloudformation: AWS.CloudFormation
  stackId: string
}) => {
  const { region } = utils.parseStackArn(stackId)
  const oldStack = await utils.getStackInfo({ cloudformation, stackId })
  const oldParameters = oldStack.Parameters
  // if (!forCreate) {
  //   setImmutableParameters(oldParameters)
  // }

  const oldOutputs = oldStack.Outputs
  const newParameters: AWS.CloudFormation.Parameter[] = oldOutputs
    .filter(r => r.OutputKey in LOGICAL_ID_TO_PARAM)
    .map(({ OutputKey, OutputValue }) => ({
      ParameterKey: LOGICAL_ID_TO_PARAM[OutputKey],
      ParameterValue: OutputValue,
    }))

  const parameters = newParameters.slice()
    // don't override anything from old stack
    .filter(({ ParameterKey }) => !oldParameters.some(p => p.ParameterKey === ParameterKey))
    .concat(oldParameters)

  return parameters
}

export const getTemplateAndParametersFromStack = async ({ cloudformation, stackId }: {
  cloudformation: AWS.CloudFormation
  stackId: string
}) => {
  const getTemplate = utils.getStackTemplate({ cloudformation, stackId })
  const getParams = deriveParametersFromStack({ cloudformation, stackId })
  const template = (await getTemplate) as CFTemplate
  const parameters = (await getParams) as AWS.CloudFormation.Parameter[]
  return { template, parameters }
}

export const restoreStack = async (opts: {
  sourceStackArn: string
  newStackName: string
  // newStackRegion: string
  stackParameters?: AWS.CloudFormation.Parameter[]
  s3PathToUploadTemplate?: string
  profile?: string
}) => {
  utils.requireOption(opts, 'sourceStackArn', 'string')
  utils.requireOption(opts, 'newStackName', 'string')
  // if (opts.newStackRegion) {
  //   utils.requireOption(opts, 'newStackRegion', 'string')
  // }

  if (opts.s3PathToUploadTemplate) {
    utils.requireOption(opts, 's3PathToUploadTemplate', 'string')
  }

  let {
    sourceStackArn,
    newStackName,
    stackParameters,
    s3PathToUploadTemplate,
    profile = 'default'
  } = opts

  utils.assertIsMyCloudStackName(newStackName)

  const { region } = utils.parseStackArn(sourceStackArn)
  const cloudformation = utils.createCloudFormationClient({ region, profile })
  const getTemplate = utils.getStackTemplate({ cloudformation, stackId: sourceStackArn })
  if (!stackParameters) {
    stackParameters = await deriveParametersFromStack({ cloudformation, stackId: sourceStackArn })
  }

  const template = await getTemplate
  if (!s3PathToUploadTemplate) {
    const deploymentBucket = stackParameters.find(({ ParameterKey }) => ParameterKey === 'ExistingDeploymentBucket')
    if (!deploymentBucket) {
      utils.requireOption(opts, 's3PathToUploadTemplate', 'string')
    }

    s3PathToUploadTemplate = `${deploymentBucket.ParameterValue}/tmp/recovery-template-${Date.now()}.json`
  }

  return createStackWithParameters({
    stackName: newStackName,
    template,
    parameters: stackParameters,
    region,
    s3PathToUploadTemplate,
    profile,
  })
}

export const validateParameters = async ({ dynamodb, parameters }: {
  dynamodb: AWS.DynamoDB
  parameters: AWS.CloudFormation.Parameter[]
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

export const createStackWithParameters = async (opts: {
  stackName: string
  region: string
  template: CFTemplate
  parameters: AWS.CloudFormation.Parameter[]
  s3PathToUploadTemplate: string
  profile?: string
}) => {
  const { stackName, region, template, parameters, s3PathToUploadTemplate, profile } = opts
  const dynamodb = utils.createDynamoDBClient({ region, profile })
  await validateParameters({ dynamodb, parameters })

  const cloudformation = utils.createCloudFormationClient({ region, profile })
  const s3 = utils.createS3Client({ region, profile })

  logger.info(`uploading template to ${s3PathToUploadTemplate}`)
  const [Bucket, Key] = utils.splitOnCharAtIdx(s3PathToUploadTemplate, s3PathToUploadTemplate.indexOf('/'))
  await s3.putObject({
    Bucket,
    Key,
    Body: new Buffer(JSON.stringify(template)),
    ACL: 'public-read',
    ContentType: 'application/json',
  }).promise()

  await utils.createStackAndWait({
    cloudformation,
    params: {
      StackName: stackName,
      Capabilities: ['CAPABILITY_NAMED_IAM'],
      TemplateURL: `https://${Bucket}.s3.amazonaws.com/${Key}`,
      Parameters: parameters,
      DisableRollback: true,
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
    name: Label,
    message: Description,
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
