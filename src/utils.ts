import path = require('path')
import fs = require('fs')
import _ = require('lodash')
import co = require('co')
import yn = require('yn')
import promptly = require('promptly')
import chalk = require('chalk')
import shelljs = require('shelljs')
import fetch = require('node-fetch')
import ModelsPack = require('@tradle/models-pack')
import _validateResource = require('@tradle/validate-resource')
import { emptyBucket } from './empty-bucket'
import { models as builtInModels } from './models'
import { logger, colors } from './logger'
import { Errors as CustomErrors } from './errors'

const debug = require('debug')('@tradle/conf')

const get = async (url) => {
  const res = await fetch(url)
  if (res.statusCode > 300) {
    throw new Error(res.statusText)
  }

  return await res.json()
}

const getNamespace = ({ models, lenses }) => {
  const model = _.values(models)[0] || _.values(lenses)[0]
  return model && ModelsPack.getNamespace(model.id)
}

const pack = ({ namespace, models, lenses }: {
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

const validateResource = resource => _validateResource({
  models: builtInModels,
  resource
})

const prettify = obj => {
  return typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2)
}

const isValidProjectPath = project => {
  return fs.existsSync(path.resolve(project, 'serverless.yml'))
}

const toEnvFile = obj => Object.keys(obj)
  .map(key => `${key}="${obj[key]}"`)
  .join('\n')

const confirmOrAbort = async (msg?:string, question:string='Continue?') => {
  if (msg) logger.warn(`WARNING: ${msg}`)

  const confirmed = await promptly.confirm(colors.question(question))
  if (!confirmed) {
    throw new CustomErrors.UserAborted()
  }
}

const acceptAll = (item:any) => true
const listStackResources = async (aws, StackName, filter=acceptAll) => {
  let resources = []
  const opts:any = { StackName }
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

const listStackResourcesByType = (type, aws, stackName) => {
  return listStackResources(aws, stackName, ({ ResourceType }) => type === ResourceType)
}

const listStackResourceIdsByType = async (type, aws, stackName) => {
  const resources = await listStackResourcesByType(type, aws, stackName)
  return resources.map(r => r.PhysicalResourceId)
}

const listStackBuckets = listStackResourcesByType.bind(null, 'AWS::S3::Bucket')
const listStackBucketIds = listStackResourceIdsByType.bind(null, 'AWS::S3::Bucket')
const listStackFunctions = listStackResourcesByType.bind(null, 'AWS::Lambda::Function')
const listStackFunctionIds = listStackResourceIdsByType.bind(null, 'AWS::Lambda::Function')

const destroyBucket = async (aws, Bucket) => {
  await emptyBucket(aws.s3, Bucket)
  await aws.s3.deleteBucket({ Bucket }).promise()
}

const deleteStack = async (aws, StackName) => {
  return await aws.cloudformation.deleteStack({ StackName }).promise()
}

const listStacks = async (aws) => {
  const listStacksOpts:any = {
    StackStatusFilter: ['CREATE_COMPLETE', 'UPDATE_COMPLETE']
  }

  let stackInfos = []
  let keepGoing = true
  while (keepGoing) {
    let {
      NextToken,
      StackSummaries
    } = await aws.cloudformation.listStacks(listStacksOpts).promise()

    stackInfos = stackInfos.concat(StackSummaries.map(({ StackId, StackName }) => ({
      id: StackId,
      name: StackName
    })))

    listStacksOpts.NextToken = NextToken
    keepGoing = !!NextToken
  }

  return stackInfos
}

const getApiBaseUrl = async (aws, StackName) => {
  const result = await aws.cloudformation.describeStacks({ StackName }).promise()
  const { Outputs } = result.Stacks[0]
  const endpoint = Outputs.find(x => x.OutputKey.match(/^ServiceEndpoint/))
  return endpoint.OutputValue
}

const splitCamelCase = str => str.split(/(?=[A-Z])/g)
const checkCommandInPath = cmd => {
  const { code } = shelljs.exec(`command -v ${cmd}`)
  if (code !== 0) {
    throw new CustomErrors.InvalidEnvironment(`Please install: ${cmd}`)
  }
}

export {
  debug,
  get,
  getNamespace,
  pack,
  validateResource,
  prettify,
  isValidProjectPath,
  toEnvFile,
  confirmOrAbort,
  listStacks,
  listStackResources,
  listStackBuckets,
  listStackBucketIds,
  listStackFunctions,
  listStackFunctionIds,
  destroyBucket,
  deleteStack,
  getApiBaseUrl,
  splitCamelCase,
  checkCommandInPath
}
