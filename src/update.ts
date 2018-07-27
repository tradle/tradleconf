import sortBy from 'lodash/sortBy'
import inquirer from 'inquirer'
import Listr from 'listr'
import promiseRetry from 'promise-retry'
import Errors from '@tradle/errors'
import { Conf, UpdateOpts } from './types'
import { Errors as CustomErrors } from './errors'
import { logger } from './logger'
import { confirmOrAbort } from './utils'

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

    updates = sortBy(updates, 'sortableTag')
    const result = await inquirer.prompt([{
      type: 'list',
      name: 'tag',
      message: 'Choose a version to update to',
      choices: updates.map(({ tag }) => ({
        name: getChoiceTextForTag(tag),
        value: tag
      })),
    }])

    tag = result.tag
    if (!force) {
      const idx = updates.findIndex(update => update.tag === tag)
      if (idx !== -1) {
        const transition = updates.slice(0, idx).find(update => isTransitionReleaseTag(update.tag))
        if (transition) {
          logger.info(`you must apply the transition version first: ${transition.tag}`)
          await confirmOrAbort(`apply transition tag ${transition.tag} now?`)
          tag = transition.tag
        }
      }
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
      title: 'load update (grab a coffee)',
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
        try {
          await triggerUpdate(ctx.update)
        } catch (err) {
          if (err.code === 'ValidationError' && err.message.includes('UPDATE_IN_PROGRESS')) {
            throw new Error('stack is currently updating, please wait for it to finish before applying another update')
          }

          throw err
        }
      }
    },
    {
      title: 'apply update (be patient, or else)',
      skip: ctx => !ctx.willUpdate,
      task: async ctx => {
        try {
          await conf.waitForStackUpdate(stackId)
        } catch (err) {
          if (err.code === 'ResourceNotReady') {
            throw new Error('failed to apply update')
          }

          throw err
        }
      }
    }
  ]).run()

  let ctx
  try {
    ctx = await promise
  } catch (err) {
    if (Errors.matches(err, CustomErrors.NotFound)) {
      throw new Error('failed to fetch the requested update')
    }

    throw err
  }

  if (ctx.upToDate && !ctx.willUpdate) {
    logger.info(`your MyCloud is already up to date!`)
  }
}

const isReleaseCandidateTag = (tag: string) => /-rc\.\d+$/.test(tag)
const isTransitionReleaseTag = (tag: string) => /-trans/.test(tag)
const getChoiceTextForTag = (tag: string) => {
  if (isTransitionReleaseTag(tag)) {
    return `${tag} (transition version, must be applied before the version that follows)`
  }

  if (isReleaseCandidateTag(tag)) {
    return `${tag} (release candidate with experimental fixes / features)`
  }

  return tag
}
