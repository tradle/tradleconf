import matches from 'lodash/matches'
import sortBy from 'lodash/sortBy'
import groupBy from 'lodash/groupBy'
import inquirer from 'inquirer'
import Listr from 'listr'
import promiseRetry from 'promise-retry'
// import { toSortableTag, sortTags, compareTags } from 'lexicographic-semver'
import Errors from '@tradle/errors'
import {
  Conf,
  AWSClients,
  PointInTime,
  Logger,
} from './types'

import { Errors as CustomErrors } from './errors'
import { logger } from './logger'
import { confirmOrAbort, ask, chooseRegion } from './prompts'
import { create as createDynamoDBMigrator } from './dynamodb'
import * as utils from './utils'

const shouldRestoreBucket = (output: AWS.CloudFormation.Output) => output.OutputKey !== 'LogsBucket'
const shouldRestoreTable = (output: AWS.CloudFormation.Output) => true

const isBucket = (output: AWS.CloudFormation.Output) => output.OutputKey.endsWith('Bucket')
const isTable = (output: AWS.CloudFormation.Output) => output.OutputKey.endsWith('Table')
// const validateSuffix = (input: string) => /^[a-z]{1-6}$/.test(input)

const TABLE_NAME_REGEX = /(.*?)(\d+)$/
const getTableTargetName = (sourceName: string) => {
  const match = sourceName.match(TABLE_NAME_REGEX)
  if (match) {
    return match[1] + (parseInt(match[2]) + 1)
  }

  return sourceName + '-1'
}

interface RestoreOpts {
  conf: Conf
  client: AWSClients
  pointInTime: PointInTime
  region: string
}

export const restore = async (opts: RestoreOpts) => {
  const { conf, client, pointInTime } = opts
  const stackId = await ask('enter the broken stack id')
  // const suffix = await ask('enter a short suffix to append to restored tables. Use lowercase letters only.', validateSuffix)
  const outputs = await utils.getStackOutputs(client, stackId)
  const buckets = outputs
    .filter(o => isBucket(o) && shouldRestoreBucket(o))
    .map(o => o.OutputValue)

  const tables = outputs
    .filter(o => isTable(o) && shouldRestoreTable(o))
    .map(o => o.OutputValue)

  const region = await chooseRegion()
  const tableMigrator = createDynamoDBMigrator(client.dynamodb)
  const promiseRestoreTables = tables.map(sourceName => tableMigrator.restoreTable({
    region,
    pointInTime,
    sourceName,
    targetName: getTableTargetName(sourceName),
  }))

  const promiseRestoreBuckets = Promise.all(buckets.map(bucket => restoreBucket({ bucket })))
  await Promise.all([
    promiseRestoreBuckets,
    promiseRestoreTables,
  ])
}

export const restoreBucket = async ({ bucket }: {
  bucket: string
}) => {
  // TODO: use s3-pit-restore
}

export const createStack = async ({ client, templateUrl, buckets, tables, immutableParameters=[], logger }: {
  client: AWSClients
  templateUrl: string
  logger: Logger
  buckets?: string[]
  tables?: string[]
  immutableParameters?: string[]
}) => {
  const stackId = await ask('enter the broken stack id')
  const template = utils.getStackTemplate(client, stackId)
  // const template = await utils.get(templateUrl)
  const groups = groupParameters(template)
  const values = {}
  await utils.series(groups, async ({ name, parameters }) => {
    parameters = parameters.filter(p => !immutableParameters.includes(p))
    if (!parameters.length) return

    logger.info(name)
    await utils.series(parameters, async ({ Name, Label, Description }) => {
      const message = Description ? `${Label}: ${Description}` : Label
      values[Name] = await ask(message)
    })
  })
}

export const getPromptsForParameters = (parameters: Parameter[]) => parameters.map(getPromptForParameter)

const createValidatorForParameter = (parameter: Parameter) => {
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

export const getPromptForParameter = (parameter: Parameter) => {
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

interface Parameter {
  Name: AWS.CloudFormation.ParameterKey
  Label: string
  Type: AWS.CloudFormation.ParameterType
  Default?: AWS.CloudFormation.ParameterValue
  Description?: string
  AllowedValues?: AWS.CloudFormation.ParameterValue[]
  AllowedPattern?: string
  ConstraintDescription?: string
  MinLength?: number
  MaxLength?: number
  MinValue?: number
  MaxValue?: number
}

interface ParameterGroup {
  name?: string
  parameters: Parameter[]
}

const IMMUTABLE_PARAMETERS = [
  'Stage',
  'BlockchainNetwork',
  'OrgName',
  'OrgDomain',
  'OrgLogo',
]

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
    })) as Parameter[]

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
