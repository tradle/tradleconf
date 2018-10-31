import fs from 'fs'
import path from 'path'
import partition from 'lodash/partition'
import sortBy from 'lodash/sortBy'
import notNull from 'lodash/identity'
import Listr from 'listr'
import AWS from 'aws-sdk'
import Errors from '@tradle/errors'
import {
  confirmOrAbort,
  confirm,
} from './prompts'

import { TRADLE_ACCOUNT_ID, BIG_BUCKETS } from './constants'
import { logger, colors } from './logger'
import * as utils from './utils'
import { getStackId as getServicesStackId } from './kyc-services'
import { Errors as CustomErrors } from './errors'

import {
  Conf,
  AWSClients,
  CloudResource,
} from './types'

type DestroyOpts = {
  client: AWSClients
  profile: string
  stackId: string
}

export const deleteCorrespondingServicesStack = async ({ client, stackId }: DestroyOpts) => {
  const { stackName } = utils.parseStackArn(stackId)
  const servicesStackId = await getServicesStackId(client.cloudformation, stackName)
  if (!servicesStackId) {
    throw new CustomErrors.NotFound(`services stack for mycloud stack: ${stackId}`)
  }

  logger.info(`KYC services stack: deleting ${servicesStackId}, ETA: 5-10 minutes`)
  await utils.deleteStackAndWait({
    cloudformation: client.cloudformation,
    params: {
      StackName: servicesStackId
    },
  })

  logger.info(`KYC services stack: deleted ${servicesStackId}`)
}

export const chooseDeleteVsRetain = async (resources: CloudResource[]) => {
  const [retainedBuckets, retainedOther] = partition(resources, r => r.type === 'bucket')
  const del:CloudResource[] = []
  const retain = BIG_BUCKETS.slice()
  for (const item of retainedBuckets.concat(retainedOther)) {
    const { type, value } = item
    if (await confirm(`Delete ${type} ${value}?`, false)) {
      del.push(item)
    } else {
      retain.push(item.name)
    }
  }

  return {
    delete: del,
    retain,
  }
}

export const deleteResources = async ({ client, resources, profile, stackId }: {
  client: AWSClients
  resources: CloudResource[]
  profile?: string
  stackId?: string
}) => {
  logger.info(`I will now delete:

${resources.map(r => r.value).join('\n')}

I'll be deleting a few things in parallel, try not to get dizzy...`)

  const [buckets, other] = partition(resources, r => r.type === 'bucket')
  const promiseDeleteBuckets = buckets.length
    ? deleteBuckets({ client, buckets, profile })
    : Promise.resolve()

  const promiseDeleteRest = other.length
    ? Promise.all(other.map(async resource => deleteResource({ client, resource })))
    : Promise.resolve([])

  await Promise.all([
    promiseDeleteBuckets,
    promiseDeleteRest
  ])
}

export const destroy = async (opts: DestroyOpts) => {
  const { client, stackId, profile } = opts
  const { stackName } = utils.parseStackArn(stackId)
  const { cloudformation } = client
  await confirmOrAbort(`DESTROY REMOTE MYCLOUD ${stackName}?? There's no undo for this one!`, false)
  await confirmOrAbort(`Are you REALLY REALLY sure you want to MURDER ${stackName}?`, false)
  let retained = await utils.listOutputResources({ cloudformation, stackId })
  retained = retained.filter(r => r.name !== 'SourceDeploymentBucket')
  retained = sortBy(retained, 'type')
  const existence = await Promise.all(retained.map(resource => utils.doesResourceExist({ client, resource })))
  retained = retained.filter((r, i) => existence[i])

  let delResourcesToo
  if (retained.length) {
    logger.info('the following resources will be retained when the stack is deleted')
    logger.info(retained.map(r => `${r.name}: ${r.value}`).join('\n'))
    delResourcesToo = await confirm(`do you want me to delete them? If you say yes, I'll ask you about them one by one`, false)
  }

  const delVsRetain = delResourcesToo ? await chooseDeleteVsRetain(retained) : { delete: [], retain: retained }
  const delServicesStack = async () => {
    try {
      await deleteCorrespondingServicesStack({ client, profile, stackId })
    } catch (err) {
      Errors.ignore(err, CustomErrors.NotFound)
      // the show must go on
    }
  }

  await new Listr([
    {
      title: 'deleting KYC services stack',
      task: delServicesStack,
    },
    {
      title: 'disabling termination protection',
      task: async (ctx) => {
        try {
          await utils.disableStackTerminationProtection({ cloudformation, stackName: stackId })
        } catch (err) {
          Errors.ignore(err, CustomErrors.NotFound)
          ctx.stackNotFound = true
        }
      }
    },
    {
      title: 'deleting primary stack',
      enabled: ctx => ctx.stackNotFound !== true,
      task: async (ctx) => {
        const opts = {
          cloudformation,
          params: { StackName: stackId }
        }

        try {
          await utils.deleteStackAndWait(opts)
        } catch (err) {
          if (Errors.matches(err, CustomErrors.NotFound)) {
            return
          }

          // @ts-ignore
          opts.params.RetainResources = uniq(delVsRetain.retain)
          await utils.deleteStackAndWait(opts)
        }
      }
    },
  ]).run()

  if (!delVsRetain.delete.length) return

  logger.info('deleting resources you chose not to retain')
  await deleteResources({ resources: delVsRetain.delete, client, profile, stackId })
}

export const deleteBuckets = async ({ client, buckets, profile }: {
  client: AWSClients
  buckets: CloudResource[]
  profile?: string
}) => {
  const [big, small] = partition(buckets, ({ name }) => BIG_BUCKETS.includes(name))

  await Promise.all(small.map(async ({ value }) => {
    logger.info(`emptying and deleting: ${value}`)
    await utils.destroyBucket(client.s3, value)
  }))

  if (!big.length) return

  const bigIds = big.map(b => b.value)
  await Promise.all(bigIds.map(async id => {
    try {
      await utils.markBucketForDeletion(client.s3, id)
    } catch (err) {
      Errors.ignore(err, CustomErrors.NotFound)
    }
  }))

  const cleanupScriptPath = path.relative(process.cwd(), createCleanupBucketsScript({
    buckets: bigIds,
    profile
  }))

  logger.info(`The following buckets are too large to delete directly:
${bigIds.join('\n')}

Instead, I've marked them for deletion by S3. They should be emptied within a day or so

After that you can delete them from the console or with this little script I created for you: ${cleanupScriptPath}
`)
}

export const deleteResource = async (opts: {
  client: AWSClients
  resource: CloudResource
}) => {
  try {
    await doDeleteResource(opts)
  } catch (err) {
    Errors.ignore(err, CustomErrors.NotFound)
  }
}

const doDeleteResource = async ({ client, resource }: {
  client: AWSClients
  resource: CloudResource
}) => {
  switch (resource.type) {
  case 'table':
    await utils.deleteTable({ dynamodb: client.dynamodb, tableName: resource.value })
    break
  case 'key':
    await utils.deleteKey({ kms: client.kms, keyId: resource.value })
    break
  case 'loggroup':
    await utils.deleteLogGroup({ logs: client.logs, name: resource.value })
    break
  default:
    logger.warn(`don't know how to delete resource of type: ${resource.type}`)
    break
  }
}

export const createCleanupBucketsScript = ({ buckets, profile }: {
  buckets: string[]
  profile: string
}) => {
  const cleanupScript = fs.existsSync(path.resolve(process.cwd(), 'cleanup-buckets.sh'))
    ? `cleanup-buckets-${Date.now()}.sh`
    : `cleanup-buckets.sh`

  const delBuckets = buckets.map(name => getDeleteBucketLine({ name, profile }))
  const scriptBody = `
#!/bin/bash

${delBuckets.join('\n')}
`

  const scriptPath = path.resolve(process.cwd(), cleanupScript)
  fs.writeFileSync(scriptPath, scriptBody)
  fs.chmodSync(scriptPath, '0755')
  return scriptPath
}

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
