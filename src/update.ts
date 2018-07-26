import sortBy from 'lodash/sortBy'
import inquirer from 'inquirer'
import Listr from 'listr'
import promiseRetry from 'promise-retry'
import Errors from '@tradle/errors'
import { Conf, UpdateOpts } from './types'
import { Errors as CustomErrors } from './errors'
import { logger } from './logger'

const USE_CURRENT_USER_ROLE = true
const MIN_VERSION = '01.01.0f'

export const update = async (conf: Conf, {
  stackId,
  tag,
  provider,
  showReleaseCandidates,
  force,
}: UpdateOpts) => {
  const getUpdateWithRetry = tag => {
    let requested
    // this might take a few tries as the update might need to be requested first
    return promiseRetry(async (retry, number) => {
      try {
        return await conf.getUpdateInfo({ tag })
      } catch (err) {
        Errors.rethrow(err, ['developer', CustomErrors.InvalidInput])
        if (!requested && Errors.matches(err, CustomErrors.NotFound)) {
          requested = true
          await conf.requestUpdate({ tag, provider })
        }

        retry(err)
      }
    }, {
      maxTimeout: 10000,
      minTimeout: 5000,
      retries: 10
    })
  }

  const version = await conf.getCurrentVersion()
  if (!(version.sortableTag && version.sortableTag > MIN_VERSION)) {
    logger.info(`you have an old version of MyCloud which doesn't support the new update mechanism
Please update manually this one time. See instructions on https://github.com/tradle/serverless`)
    return
  }

  if (!tag) {
    let updates = await conf.listUpdates({ provider })
    if (!showReleaseCandidates) {
      updates = updates.filter(update => !isReleaseCandidateTag(update.tag))
    }

    if (!updates.length) {
      logger.info(`no updates available`)
      return
    }

    if (updates.length === 1) {
      tag = updates[0].tag
      const { doUpdate } = await inquirer.prompt([{
        type: 'confirm',
        name: 'doUpdate',
        message: `Update to version ${tag} ?`,
      }])

      if (!doUpdate) return
    } else {
      const result = await inquirer.prompt([{
        type: 'list',
        name: 'tag',
        message: 'Choose a version to update to',
        choices: sortBy(updates, 'sortableTag').map(u => ({
          name: u.tag,
          value: u.sortableTag
        })),
      }])

      tag = result.tag
    }
  }

  const triggerUpdate = async (update) => {
    if (USE_CURRENT_USER_ROLE) {
      await conf.applyUpdateAsCurrentUser(update)
    } else {
      await conf.applyUpdateViaLambda(update)
    }
  }

  const promise = await new Listr([
    {
      title: 'download update (grab a coffee)',
      task: async ctx => {
        const resp = await getUpdateWithRetry(tag)
        if (!resp) return

        const { update, upToDate } = resp
        ctx.upToDate = upToDate
        ctx.update = update
        ctx.willUpdate = force || !upToDate
      }
    },
    {
      title: 'validate update',
      skip: ctx => !ctx.willUpdate,
      task: async ctx => {
        await triggerUpdate(ctx.update)
      }
    },
    {
      title: 'apply update (be patient, or else)',
      skip: ctx => !ctx.willUpdate,
      task: async ctx => {
        await conf.waitForStackUpdate(stackId)
      }
    }
  ]).run()

  let ctx
  try {
    ctx = await promise
  } catch (err) {
    if (Errors.matches(err, CustomErrors.NotFound)) {
      logger.error('failed to fetch the requested update')
    }

    throw err
  }

  if (ctx.upToDate && !ctx.willUpdate) {
    logger.info(`your MyCloud is already up to date!`)
  }
}

const isReleaseCandidateTag = (tag: string) => /-rc\.\d+$/.test(tag)
