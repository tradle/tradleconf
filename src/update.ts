import inquirer from 'inquirer'
import Listr from 'listr'
import promiseRetry from 'promise-retry'
import Errors from '@tradle/errors'
import { Conf } from './types'
import { Errors as CustomErrors } from './errors'
import { logger } from './logger'

const USE_CURRENT_USER_ROLE = true

export const update = async (conf: Conf, { stackId, tag, provider, force }) => {
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

  if (!tag) {
    const updates = await conf.listUpdates({ provider })
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
        message: 'Choose a version to update to (use arrow keys)',
        choices: updates.map(u => u.tag),
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

  const ctx = await new Listr([
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

  if (ctx.upToDate && !ctx.willUpdate) {
    logger.info(`your MyCloud is already up to date!`)
  }
}
