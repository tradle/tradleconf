const path = require('path')
const fs = require('fs')
const _ = require('lodash')
const co = require('co')
const yn = require('yn')
const promptly = require('promptly')
const chalk = require('chalk')
const debug = require('debug')('@tradle/conf')
// const debug = (...args) => console.log(...args)
const ModelsPack = require('@tradle/models-pack')
const _validateResource = require('@tradle/validate-resource')
const emptyBucket = require('./empty-bucket')
const builtInModels = require('./models')
const logger = require('./logger')
const CustomErrors = require('./errors')

const getNamespace = ({ models, lenses }) => {
  const model = _.values(models)[0] || _.values(lenses)[0]
  return model && ModelsPack.getNamespace(model.id)
}

const pack = ({ namespace, models, lenses }) => {
  if (!(_.size(models) || _.size(lenses))) {
    throw new Error('expected "models" and/or "lenses"')
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

const confirmOrAbort = co.wrap(function* (msg, question='Continue?') {
  if (msg) logger.warn(`WARNING: ${msg}`)

  const confirmed = yield promptly.confirm(logger.color.question(question))
  if (!confirmed) {
    throw new CustomErrors.UserAborted()
  }
})

const listStackResources = co.wrap(function* (aws, StackName) {
  let resources = []
  const opts = { StackName }
  while (true) {
    let {
      StackResourceSummaries,
      NextToken
    } = yield aws.cloudformation.listStackResources(opts).promise()

    resources = resources.concat(StackResourceSummaries)
    opts.NextToken = NextToken
    if (!opts.NextToken) break
  }

  return resources
})

const listStackBuckets = co.wrap(function* (aws, stackName) {
  const resources = yield listStackResources(aws, stackName)
  return resources
    .filter(r => r.ResourceType === 'AWS::S3::Bucket')
    .map(r => r.PhysicalResourceId)
})

const destroyBucket = co.wrap(function* (aws, Bucket) {
  yield emptyBucket(aws.s3, Bucket)
  yield aws.s3.deleteBucket({ Bucket }).promise()
})

const deleteStack = co.wrap(function* (aws, StackName) {
  return yield aws.cloudformation.deleteStack({ StackName }).promise()
})

const listStacks = co.wrap(function* (aws) {
  const listStacksOpts = {
    StackStatusFilter: ['CREATE_COMPLETE', 'UPDATE_COMPLETE']
  }

  let stackInfos = []
  let keepGoing = true
  while (keepGoing) {
    let {
      NextToken,
      StackSummaries
    } = yield aws.cloudformation.listStacks(listStacksOpts).promise()

    stackInfos = stackInfos.concat(StackSummaries.map(({ StackId, StackName }) => ({
      id: StackId,
      name: StackName
    })))

    listStacksOpts.NextToken = NextToken
    keepGoing = !!NextToken
  }

  return stackInfos
})

const getApiBaseUrl = co.wrap(function* (aws, StackName) {
  const result = yield aws.cloudformation.describeStacks({ StackName }).promise()
  const { Outputs } = result.Stacks[0]
  const endpoint = Outputs.find(x => x.OutputKey.match(/^ServiceEndpoint/))
  return endpoint.OutputValue
})

module.exports = {
  getNamespace,
  pack,
  validateResource,
  debug,
  prettify,
  isValidProjectPath,
  toEnvFile,
  confirmOrAbort,
  listStacks,
  listStackResources,
  listStackBuckets,
  destroyBucket,
  deleteStack,
  getApiBaseUrl
}
