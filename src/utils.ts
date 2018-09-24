import crypto from 'crypto'
import path from 'path'
import fs from 'fs'
import _ from 'lodash'
import co from 'co'
import yn from 'yn'
import promptly from 'promptly'
import chalk from 'chalk'
import shelljs from 'shelljs'
import fetch from 'node-fetch'
import _AWS from 'aws-sdk'
import ModelsPack from '@tradle/models-pack'
import _validateResource from '@tradle/validate-resource'
import Errors from '@tradle/errors'
import { emptyBucket } from './empty-bucket'
import { models as builtInModels } from './models'
import { logger, colors } from './logger'
import { Errors as CustomErrors } from './errors'
import { confirm } from './prompts'

type AWS = {
  s3: _AWS.S3
  cloudformation: _AWS.CloudFormation
  // autoscaling: _AWS.AutoScaling
  lambda: _AWS.Lambda
  ecr: _AWS.ECR
  ec2: _AWS.EC2
}

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
  // ModelsPack.validate({ builtInModels, modelsPack })
  return modelsPack
}

export const validateResource = resource => _validateResource({
  models: builtInModels,
  resource
})

export const prettify = obj => {
  return typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2)
}

export const isValidProjectPath = project => {
  return fs.existsSync(path.resolve(project, 'serverless.yml'))
}

export const toEnvFile = obj => Object.keys(obj)
  .map(key => `${key}="${obj[key]}"`)
  .join('\n')

export const confirmOrAbort = async (msg:string) => {
  const confirmed = await confirm(msg)
  if (!confirmed) {
    throw new CustomErrors.UserAborted()
  }
}

const acceptAll = (item:any) => true

export const listStackResources = async (aws: AWS, StackName: string, filter=acceptAll) => {
  let resources = []
  const opts:_AWS.CloudFormation.ListStackResourcesInput = { StackName }
  while (true) {
    let {
      StackResourceSummaries,
      NextToken
    } = await aws.cloudformation.listStackResources(opts).promise()

    resources = resources.concat(StackResourceSummaries.filter(filter))
    opts.NextToken = NextToken
    if (!opts.NextToken) break
  }

  return resources
}

export const listStackResourcesByType = (type, aws: AWS, stackName:string) => {
  return listStackResources(aws, stackName, ({ ResourceType }) => type === ResourceType)
}

export const listStackResourceIdsByType = async (type, aws: AWS, stackName:string) => {
  const resources = await listStackResourcesByType(type, aws, stackName)
  return resources.map(r => r.PhysicalResourceId)
}

export const listStackBuckets = listStackResourcesByType.bind(null, 'AWS::S3::Bucket')
export const listStackBucketIds = listStackResourceIdsByType.bind(null, 'AWS::S3::Bucket')
export const listStackFunctions = listStackResourcesByType.bind(null, 'AWS::Lambda::Function')
export const listStackFunctionIds = listStackResourceIdsByType.bind(null, 'AWS::Lambda::Function')

export const destroyBucket = async (aws: AWS, Bucket: string) => {
  await emptyBucket(aws.s3, Bucket)
  try {
    await aws.s3.deleteBucket({ Bucket }).promise()
  } catch (err) {
    Errors.ignore(err, [
      { code: 'ResourceNotFoundException' },
      { code: 'NoSuchBucket' },
    ])
  }
}

export const disableStackTerminationProtection = async (aws: AWS, StackName:string) => {
  return await aws.cloudformation.updateTerminationProtection({
    StackName,
    EnableTerminationProtection: false,
  }).promise()
}

export const deleteStack = async (aws: AWS, StackName:string) => {
  while (true) {
    try {
      await aws.cloudformation.deleteStack({ StackName }).promise()
      return () => awaitStackDelete(aws, StackName)
    } catch (err) {
      if (!err.message.includes('UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS')) {
        throw err
      }

      // back off, try again
      await wait(5000)
    }
  }
}

export const createStack = async (aws: AWS, params: AWS.CloudFormation.CreateStackInput) => {
  await aws.cloudformation.createStack(params).promise()
  return () => awaitStackCreate(aws, params.StackName)
}

export const updateStack = async (aws: AWS, params: AWS.CloudFormation.UpdateStackInput) => {
  await aws.cloudformation.updateStack(params).promise()
  return () => awaitStackUpdate(aws, params.StackName)
}

const isUpdateableStatus = (status: AWS.CloudFormation.StackStatus) => {
  return status.endsWith('_COMPLETE') && !status.startsWith('DELETE_')
}

export const getStackId = async (aws: AWS, stackName: string) => {
  const stacks = await listStacks(
    aws,
    ({ StackName, StackStatus }) => StackName === stackName && isUpdateableStatus(StackStatus)
  )

  return stacks[0] && stacks[0].id
}

// export const createOrUpdateStack = async (aws: AWS, params: AWS.CloudFormation.UpdateStackInput) => {
//   const StackId = await getStackId(aws, params.StackName)
//   if (StackId) {
//     await updateStack(aws, params)
//   } else {
//     await createStack(aws, params)
//   }
// }

export const awaitStackCreate = async (aws: AWS, StackName:string) => {
  return await aws.cloudformation.waitFor('stackCreateComplete', { StackName }).promise()
}

export const awaitStackDelete = async (aws: AWS, StackName:string) => {
  return await aws.cloudformation.waitFor('stackDeleteComplete', { StackName }).promise()
}

export const awaitStackUpdate = async (aws: AWS, StackName:string) => {
  return await aws.cloudformation.waitFor('stackUpdateComplete', { StackName }).promise()
}

type FilterStackSummary = (item: AWS.CloudFormation.StackSummary) => boolean

export const listStacks = async (aws: AWS, filter:FilterStackSummary=acceptAll) => {
  const listStacksOpts:_AWS.CloudFormation.ListStacksInput = {
    StackStatusFilter: ['CREATE_COMPLETE', 'UPDATE_COMPLETE']
  }

  let stackInfos = []
  let keepGoing = true
  while (keepGoing) {
    let {
      NextToken,
      StackSummaries
    } = await aws.cloudformation.listStacks(listStacksOpts).promise()

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

export const getApiBaseUrl = async (aws: AWS, StackName:string) => {
  const result = await aws.cloudformation.describeStacks({ StackName }).promise()
  const { Outputs } = result.Stacks[0]
  const endpoint = Outputs.find(x => /^ServiceEndpoint/.test(x.OutputKey))
  return endpoint.OutputValue
}

export const splitCamelCase = str => str.split(/(?=[A-Z])/g)
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

export const getServicesStackName = (stackName: string) => {
  const name = stackName.match(/^tdl-(.*?)-ltd-[a-zA-Z]+$/)[1]
  const shortName = shortenString(name, 14)
  return `${shortName}-srvcs` // max length 20 chars
}

export const canAccessECRRepos = async (aws: AWS, { accountId, repoNames }: {
  accountId: string,
  repoNames: string[]
}) => {
  try {
    await aws.ecr.describeRepositories({
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

export const doKeyPairsExist = async (aws: AWS, names: string[]) => {
  const params: AWS.EC2.DescribeKeyPairsRequest = {
    KeyNames: names
  }

  try {
    await aws.ec2.describeKeyPairs(params).promise()
    return true
  } catch (err) {
    return false
  }
}

export const listKeyPairs = async (aws: AWS) => {
  const { KeyPairs } = await aws.ec2.describeKeyPairs().promise()
  return KeyPairs.map(k => k.KeyName)
}
