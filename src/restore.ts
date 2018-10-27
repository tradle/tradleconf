import matches from 'lodash/matches'
import sortBy from 'lodash/sortBy'
import groupBy from 'lodash/groupBy'
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
  // RestoreTableCliOpts,
} from './types'

import { Errors as CustomErrors } from './errors'
import { logger } from './logger'
import { confirmOrAbort, ask, chooseRegion } from './prompts'
import { create as wrapDynamoDB } from './dynamodb'
import * as utils from './utils'
import { IMMUTABLE_STACK_PARAMETERS } from './constants'

const shouldRestoreBucket = (output: CloudResource) => output.name !== 'LogsBucket'
const shouldRestoreTable = (output: CloudResource) => true

// const isBucket = (output: AWS.CloudFormation.Output) => output.OutputKey.endsWith('Bucket')
// const isTable = (output: AWS.CloudFormation.Output) => output.OutputKey.endsWith('Table')
// const validateSuffix = (input: string) => /^[a-z]{1-6}$/.test(input)

const TABLE_NAME_REGEX = /(.*?)(\d+)$/
const getTableTargetName = (sourceName: string) => {
  const match = sourceName.match(TABLE_NAME_REGEX)
  if (match) {
    return match[1] + (parseInt(match[2]) + 1)
  }

  return sourceName + '-1'
}

const getBucketTargetName = getTableTargetName

interface RestoreResourcesOpts {
  client: AWSClients
  date: PointInTime
  profile?: string
}

export const restoreResources = async (opts: RestoreResourcesOpts) => {
  const { client, date, profile } = opts
  const stackId = await ask('enter the broken stack id')
  // const suffix = await ask('enter a short suffix to append to restored tables. Use lowercase letters only.', validateSuffix)
  const outputs = await utils.listOutputResources({ cloudformation: client.cloudformation, stackId })
  const buckets = outputs
    .filter(o => o.type === 'bucket' && shouldRestoreBucket(o))
    .map(o => o.value)

  const tables = outputs
    .filter(o => o.type === 'table' && shouldRestoreTable(o))
    .map(o => o.value)

  const region = await chooseRegion()
  const promiseRestoreTables = tables.map(sourceName => restoreTable({
    dynamodb: client.dynamodb,
    date,
    sourceName,
    destName: getTableTargetName(sourceName),
  }))

  const promiseRestoreBuckets = Promise.all(buckets.map(source => restoreBucket({
    s3: client.s3,
    date,
    source,
    dest: getBucketTargetName(source),
    profile,
  })))

  await Promise.all([
    promiseRestoreBuckets,
    promiseRestoreTables,
  ])
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

export const createStack = async ({ client, templateUrl, buckets, tables, immutableParameters=[], logger }: {
  client: AWSClients
  templateUrl: string
  logger: Logger
  buckets?: string[]
  tables?: string[]
  immutableParameters?: string[]
}) => {
  const stackId = await ask('enter the broken stack id')
  const template = utils.getStackTemplate({ cloudformation: client.cloudformation, stackId })
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

export const cloneStack = async (opts: {
  sourceStackArn: string
  newStackName: string
  // newStackRegion: string
  parameters?: AWS.CloudFormation.Parameter[]
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
    parameters,
    s3PathToUploadTemplate,
    profile = 'default'
  } = opts

  utils.assertIsMyCloudStackName(newStackName)

  const { region } = utils.parseStackArn(sourceStackArn)
  const cloudformation = utils.createCloudFormationClient({ region, profile })
  const getTemplate = utils.getStackTemplate({ cloudformation, stackId: sourceStackArn })
  if (!parameters) {
    parameters = await deriveParametersFromStack({ cloudformation, stackId: sourceStackArn })
  }

  const template = await getTemplate
  if (!s3PathToUploadTemplate) {
    const deploymentBucket = parameters.find(({ ParameterKey }) => ParameterKey === 'ExistingDeploymentBucket')
    if (!deploymentBucket) {
      utils.requireOption(opts, 's3PathToUploadTemplate', 'string')
    }

    s3PathToUploadTemplate = `${deploymentBucket.ParameterValue}/tmp/recovery-template-${Date.now()}.json`
  }

  return createStackWithParameters({
    stackName: newStackName,
    template,
    parameters,
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

const validateISODate = (dateString: string) => {
  const date = new Date(dateString)
  if (date.toISOString() !== dateString) {
    throw new CustomErrors.InvalidInput(`expected iso date, e.g. ${new Date().toISOString()}`)
  }
}

export const doesBucketExist = async ({ s3, bucket }: {
  s3: AWS.S3
  bucket: string
}) => {
  try {
    await s3.headBucket({ Bucket: bucket }).promise()
  } catch (err) {
    Errors.ignore(err, { code: 'NotFound' })
    throw new CustomErrors.NotFound(`bucket ${bucket} either doesn't exist or you don't have access`)
  }
}

export const restoreBucket = async ({ s3, source, dest, date, profile }: {
  s3: AWS.S3
  source: string
  dest: string
  date: string
  profile?: string
}) => {
  validateISODate(date)

  await doesBucketExist({ s3, bucket: source })
  try {
    await doesBucketExist({ s3, bucket: dest })
  } catch (err) {
    Errors.ignore(err, CustomErrors.NotFound)
    logger.info(`creating bucket ${dest}`)
    await s3.createBucket({ Bucket: dest }).promise()
  }

  const env:any = {}
  if (profile) env.AWS_PROFILE = env

  const destDir = `restore/${dest}`

  try {
    execa.sync('command', ['-v', 's3-pit-restore'])
  } catch (err) {
    throw new CustomErrors.NotFound(`please install this tool first: https://github.com/madisoft/s3-pit-restore`)
  }

  await new Listr([
    {
      title: `syncing ${source} -> ${destDir}`,
      task: async () => {
        await execa('s3-pit-restore', ['-b', source, '-d', destDir, '-t', date], { env })
      }
    },
    {
      title: `syncing ${destDir} -> ${dest}`,
      task: async () => {
        await execa('aws', ['s3', 'sync', destDir, `s3://${dest}`], { env })
      }
    },
    {
      title: `cleaning ${destDir}`,
      task: async () => {
        await execa('rm', ['-rf', destDir])
      }
    },
  ]).run()
}

interface RestoreTableOpts {
  dynamodb: AWS.DynamoDB
  sourceName: string
  destName: string
  date: PointInTime
}

export const doRestoreTable = async ({ dynamodb, sourceName, destName, date }: RestoreTableOpts) => {
  validateISODate(date)

  const migrator = wrapDynamoDB(dynamodb)
  await migrator.restoreTable({ sourceName, destName, date })
}

export const restoreTable = async (opts: RestoreTableOpts) => {
  const { sourceName, destName } = opts
  await new Listr([
    {
      title: `restoring ${sourceName} -> ${destName}`,
      task: () => restoreTable(opts),
    }
  ])
}
