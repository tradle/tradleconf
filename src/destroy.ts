import fs from 'fs'
import path from 'path'
import partition from 'lodash/partition'
import sortBy from 'lodash/sortBy'
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

export const deleteResources = async ({ client, resources, profile, stackId }: {
  client: AWSClients
  resources: CloudResource[]
  profile?: string
  stackId?: string
}) => {
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

  if (del.length) {
    logger.info(`I will now delete:

${del.map(r => r.value).join('\n')}
`)
    await confirmOrAbort('Continue?', false)
    logger.info(`OK, here we go! I'll be deleting a few things in parallel, try not to get dizzy...`)
  } else {
    logger.info(`OK, here we go!`)
  }

  const promiseDeleteServicesStack = deleteCorrespondingServicesStack({ client, profile, stackId }).catch(err => {
    Errors.ignore(err, CustomErrors.NotFound)
    logger.error(err.message)
    // the show must go on
  })

  const [buckets, other] = partition(del, r => r.type === 'bucket')
  const promiseDeleteBuckets = buckets.length
    ? deleteBuckets({ client, buckets: buckets.map(r => r.value), profile })
    : Promise.resolve()

  const promiseDeleteRest = other.length
    ? Promise.all(other.map(resource => deleteResource({ client, resource })))
    : Promise.resolve([])

  await Promise.all([
    promiseDeleteServicesStack,
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
  const retained = sortBy(await utils.listOutputResources({ cloudformation, stackId }), 'type')

  logger.info('the following resources will be retained when the stack is deleted')
  logger.info(retained.map(r => `${r.name}: ${r.value}`).join('\n'))
  const delResourcesToo = await confirm(`do you want me to delete them? If you say yes, I'll ask you about them one by one`)
  await new Listr([
    {
      title: `deleting stack resources that were not explicitly retained`,
      enabled: () => delResourcesToo,
      task: () => deleteResources({ resources: retained, client, profile, stackId }),
    },
    {
      title: 'disabling termination protection',
      task: () => utils.disableStackTerminationProtection(cloudformation, stackId),
    },
    {
      title: 'deleting primary stack',
      task: async (ctx) => {
        const opts = {
          cloudformation,
          params: { StackName: stackId }
        }

        try {
          await utils.deleteStackAndWait(opts)
        } catch (err) {
          // @ts-ignore
          opts.params.RetainResources = uniq(retain)
          await utils.deleteStackAndWait(opts)
        }
      }
    },
  ]).run()
}

export const deleteBuckets = async ({ client, buckets, profile }: {
  client: AWSClients
  buckets: string[]
  profile?: string
}) => {
  const [big, small] = partition(buckets, id => BIG_BUCKETS.find(logical => id.includes(logical.toLowerCase())))

  await Promise.all(small.map(async id => {
    logger.info(`emptying and deleting: ${id}`)
    await utils.destroyBucket(client.s3, id)
  }))

  await Promise.all(big.map(id => utils.markBucketForDeletion(client.s3, id)))
  const cleanupScriptPath = path.relative(process.cwd(), createCleanupBucketsScript({ buckets: big, profile }))

  logger.info(`The following buckets are too large to delete directly:
${big.join('\n')}

Instead, I've marked them for deletion by S3. They should be emptied within a day or so

After that you can delete them from the console or with this little script I created for you: ${cleanupScriptPath}
`)
}

export const deleteResource = async ({ client, resource }: {
  client: AWSClients
  resource: CloudResource
}) => {
  switch (resource.type) {
  case 'table':
    await client.dynamodb.deleteTable({ TableName: resource.value }).promise()
    break
  case 'key':
    await client.kms.disableKey({ KeyId: resource.value }).promise()
    await client.kms.scheduleKeyDeletion({ KeyId: resource.value }).promise()
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
