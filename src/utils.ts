import { promisify } from 'util'
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
import { ConfOpts } from './types'
import { REMOTE_ONLY_COMMANDS, SAFE_REMOTE_COMMANDS } from './constants'

const MY_CLOUD_STACK_NAME_REGEX = /^tdl-(.*?)-ltd-([a-zA-Z]+)$/

type AWS = {
  s3: _AWS.S3
  cloudformation: _AWS.CloudFormation
  // autoscaling: _AWS.AutoScaling
  lambda: _AWS.Lambda
  ecr: _AWS.ECR
  ec2: _AWS.EC2
  opsworks: _AWS.OpsWorks
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

export const markBucketForDeletion = async (aws: AWS, Bucket: string) => {
  const params: AWS.S3.PutBucketLifecycleConfigurationRequest = {
    Bucket,
    LifecycleConfiguration: {
      Rules: [
        {
          Status: 'Enabled',
          ID: 'expires-in-1-day',
          Prefix: '',
          Expiration: {
            Days: 1,
          },
          NoncurrentVersionExpiration: {
            NoncurrentDays: 1
          }
        }
      ]
    }
  }

  await aws.s3.putBucketLifecycleConfiguration(params).promise()
}

export const disableStackTerminationProtection = async (aws: AWS, StackName:string) => {
  return await aws.cloudformation.updateTerminationProtection({
    StackName,
    EnableTerminationProtection: false,
  }).promise()
}

export const deleteStack = async (aws: AWS, params:AWS.CloudFormation.DeleteStackInput) => {
  while (true) {
    try {
      await aws.cloudformation.deleteStack(params).promise()
      return () => awaitStackDelete(aws, params.StackName)
    } catch (err) {
      if (!err.message.includes('UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS')) {
        throw err
      }

      // back off, try again
      await wait(5000)
    }
  }
}

export const createStackInRegion = async ({ region, params }: {
  region: string
  params: AWS.CloudFormation.CreateStackInput
}) => {
  return createStack({
    cloudformation: new _AWS.CloudFormation({ region })
  }, params)
}

export const updateStackInRegion = async ({ region, params }: {
  region: string
  params: AWS.CloudFormation.UpdateStackInput
}) => {
  return updateStack({
    cloudformation: new _AWS.CloudFormation({ region })
  }, params)
}

export const createStack = async ({ cloudformation }: {
  cloudformation: _AWS.CloudFormation
}, params: AWS.CloudFormation.CreateStackInput) => {
  await cloudformation.createStack(params).promise()
  return () => awaitStackCreate({ cloudformation }, params.StackName)
}

export const updateStack = async ({ cloudformation }: {
  cloudformation: _AWS.CloudFormation
}, params: AWS.CloudFormation.UpdateStackInput) => {
  await cloudformation.updateStack(params).promise()
  return () => awaitStackUpdate({ cloudformation }, params.StackName)
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

export const awaitStackCreate = async ({ cloudformation }: {
  cloudformation: _AWS.CloudFormation
}, stackName:string) => {
  return waitFor({ cloudformation, event: 'stackCreateComplete', stackName })
}

export const awaitStackDelete = async ({ cloudformation }: {
  cloudformation: _AWS.CloudFormation
}, stackName:string) => {
  return waitFor({ cloudformation, event: 'stackDeleteComplete', stackName })
}

export const awaitStackUpdate = async ({ cloudformation }: {
  cloudformation: _AWS.CloudFormation
}, stackName:string) => {
  return waitFor({ cloudformation, event: 'stackUpdateComplete', stackName })
}

export const waitFor = async ({ cloudformation, stackName, event }: {
  cloudformation: _AWS.CloudFormation
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

export const listStacks = async (aws: AWS, filter:FilterStackSummary=acceptAll) => {
  const listStacksOpts:_AWS.CloudFormation.ListStacksInput = {
    StackStatusFilter: ['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE']
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

const parseMyCloudStackName = (name: string) => {
  const [shortName, stage] = name.match(MY_CLOUD_STACK_NAME_REGEX).slice(1)
  return {
    shortName,
    stage,
  }
}

export const isMyCloudStackName = (name: string) => MY_CLOUD_STACK_NAME_REGEX.test(name)

export const getServicesStackName = (stackName: string) => {
  const { shortName } = parseMyCloudStackName(stackName)
  const shorterName = shortenString(shortName, 14)
  return `${shorterName}-srvcs` // max length 20 chars
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

// export const listRegions = async (aws: AWS) => {
//   const { Regions } = await aws.ec2.describeRegions().promise()
//   return Regions.map(r => r.RegionName)
// }

export const listAZs = async ({ region }) => {
  const ec2 = new _AWS.EC2({ region })
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

export const getUsedEIPCount = async (aws: AWS) => {
  const { Addresses } = await aws.ec2.describeAddresses().promise()
  return Addresses.length
}

export const getConsoleLinkForStacksInRegion = ({ region, status='active' }) => {
  return `https://${region}.console.aws.amazon.com/cloudformation/home?region=${region}#/stacks?filter=${status}`
}

export const updateEnvironments = async (aws: AWS, { functions, transform }: {
  functions: string[]
  transform: ({ name: string, env: any }) => any
}) => {
  const confs = await Promise.all(functions.map(FunctionName => aws.lambda.getFunctionConfiguration({ FunctionName }).promise()))
  await Promise.all(functions.map(async (FunctionName, i) => {
    const conf = confs[i]
    const Variables = transform({
      name: FunctionName,
      env: conf.Environment.Variables
    })

    await aws.lambda.updateFunctionConfiguration({
      FunctionName,
      Environment: { Variables }
    }).promise()
  }))
}

export const xor = (...args) => args.reduce((acc, next) => {

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
