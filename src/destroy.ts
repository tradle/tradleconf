import fs from 'fs'
import path from 'path'
import partition from 'lodash/partition'
import Listr from 'listr'
import {
  confirmOrAbort,
  confirm,
} from './prompts'

import { TRADLE_ACCOUNT_ID, BIG_BUCKETS } from './constants'
import { logger, colors } from './logger'
import * as utils from './utils'
import { getStackId as getServicesStackId } from './kyc-services'

import {
  Conf,
  AWSClients,
} from './types'

type DestroyOpts = {
  client: AWSClients
  profile: string
  stackName: string
}

const deleteStackAndAwaitDeleted = async (client: AWSClients, stackName: string) => {
  await utils.deleteStack(client, { StackName: stackName })
  await utils.wait(5000)
  await utils.awaitStackDelete(client, stackName)
}

export const deleteServicesStack = async ({ client, profile, stackName }: DestroyOpts) => {
  const servicesStackId = await getServicesStackId(client, stackName)
  if (!servicesStackId) return

  logger.info(`KYC services stack: deleting ${servicesStackId}, ETA: 5-10 minutes`)
  await deleteStackAndAwaitDeleted(client, servicesStackId)
  logger.info(`KYC services stack: deleted ${servicesStackId}`)
}

export const destroy = async (opts: DestroyOpts) => {
  const { client, stackName, profile } = opts
  await confirmOrAbort(`DESTROY REMOTE MYCLOUD ${stackName}?? There's no undo for this one!`)
  await confirmOrAbort(`Are you REALLY REALLY sure you want to MURDER ${stackName}?`)
  let buckets = await utils.listStackBucketIds(client, stackName)
  buckets.forEach(id => logger.info(id))
  await confirmOrAbort('Delete these buckets?')

  logger.info(`OK, here we go! I'll be deleting a few things in parallel...`)

  const promiseDeleteServices = deleteServicesStack(opts)
  const [big, small] = partition(buckets, id => BIG_BUCKETS.find(logical => id.includes(logical.toLowerCase())))

  await Promise.all(small.map(async id => {
    logger.info(`emptying and deleting: ${id}`)
    await utils.destroyBucket(client, id)
  }))

  await new Listr([
    {
      title: 'disabling termination protection',
      task: async (ctx) => {
        await utils.disableStackTerminationProtection(client, stackName)
      }
    },
    {
      title: 'deleting primary stack',
      task: async (ctx) => {
        try {
          await deleteStackAndAwaitDeleted(client, stackName)
        } catch (err) {
          await utils.deleteStack(client, { StackName: stackName, RetainResources: BIG_BUCKETS })
        }
      }
    },
  ]).run()

  await promiseDeleteServices
  await Promise.all(big.map(id => utils.markBucketForDeletion(client, id)))
  const cleanupScriptPath = path.relative(process.cwd(), createCleanupBucketsScript({ buckets: big, profile }))

  logger.info(`The following buckets are too large to delete directly:
${big.join('\n')}

Instead, I've marked them for deletion by S3. They should be emptied within a day or so

After that you can delete them from the console or with this little script I created for you: ${cleanupScriptPath}
`)
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
