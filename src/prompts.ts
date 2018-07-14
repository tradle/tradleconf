import fs from 'fs'
import os from 'os'
import yn from 'yn'
// import execa from 'execa'
import inquirer from 'inquirer'
import Listr from 'listr'
import promiseRetry from 'promise-retry'
import models from '@tradle/models-cloud'
import Errors from '@tradle/errors'
import { Errors as CustomErrors } from './errors'
import { logger } from './logger'
import { isValidProjectPath } from './utils'
import { Conf } from './types'

const regions = models['tradle.cloud.AWSRegion'].enum.map(({ id, title }) => ({
  name: title,
  value: id.replace(/[.]/g, '-')
}))

const PROFILE_REGEX = /^\[(?:[^\s]*?\s)?(.*)\]$/
const getProfileName = line => line.match(PROFILE_REGEX)[1]
const parseConf = conf => ({
  profiles: conf.split('\n')
    .filter(s => s.startsWith('['))
    .map(getProfileName)
})

const getProfiles = () => {
  let conf
  try {
    conf = fs.readFileSync(`${os.homedir()}/.aws/credentials`, { encoding: 'utf8' })
  } catch (err) {
    return ['default']
  }

  const { profiles } = parseConf(conf)
  return profiles.includes('default') ? profiles : ['default'].concat(profiles)
}

type PromptList = any[]

export const init = async (conf: Conf) => {
  const defaultWhen = answers => answers.overwriteEnv !== false
  const chooseFlow:PromptList = [
    {
      type: 'confirm',
      name: 'overwriteEnv',
      message: 'This will overwrite your .env file',
      when: () => fs.existsSync('./.env')
    },
    {
      type: 'confirm',
      name: 'haveRemote',
      message: 'Have you already deployed your MyCloud to AWS?'
    }
  ]

  const getLocal:PromptList = [
    {
      type: 'confirm',
      name: 'haveLocal',
      message: 'Do you have a local development environment? (a clone of https://github.com/tradle/serverless)'
    },
    {
      type: 'input',
      name: 'projectPath',
      message: 'Enter the path to your local development environment (a clone of https://github.com/tradle/serverless)',
      when: answers => defaultWhen(answers) && answers.haveLocal,
      validate: local => {
        if (!isValidProjectPath(local)) {
          return 'Provided path doesn\'t contain a serverless.yml, please try again'
        }

        return true
      }
    }
  ]

  const flow = await inquirer.prompt(chooseFlow)
  if (!flow.haveRemote) {
    return {
      ...flow,
      ...(await inquirer.prompt(getLocal))
    }
  }

  const getRemoteAndLocal:PromptList = [
    {
      type: 'list',
      name: 'region',
      message: 'Which AWS region is your deployment in?',
      choices: regions
    },
    {
      type: 'list',
      name: 'awsProfile',
      message: 'Select your aws profile',
      when: defaultWhen,
      choices: getProfiles()
        .map(profile => ({
          name: profile,
          value: profile
        }))
        .concat([
          new inquirer.Separator(),
          {
            name: 'Other (specify)',
            value: null
          }
        ]),
    },
    {
      type: 'input',
      name: 'awsProfile',
      message: 'profile',
      when: answers => answers.overwriteEnv && !answers.awsProfile
    },
    {
      type: 'list',
      name: 'stack',
      message: 'Which Tradle stack will you be configuring?',
      when: defaultWhen,
      choices: async ({ region, awsProfile }) => {
        const stackInfos = await conf.getStacks({
          profile: awsProfile,
          region
        })

        return stackInfos.map(({ name, id }) => ({
          name,
          value: { name, id }
        }))
      }
    },
  ].concat(getLocal)

  return {
    ...flow,
    ...(await inquirer.prompt(getRemoteAndLocal))
  }
}

export const fn = (conf: Conf, message: string) => {
  return inquirer.prompt([
    {
      type: 'list',
      name: 'fn',
      message,
      choices: conf.getFunctions
    }
  ])
  .then(({ fn }) => fn)
}

export const confirm = (message: string) => {
  return inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirm',
      message
    }
  ])
  .then(({ confirm }) => confirm)
}

export const update = async (conf: Conf, { stackId, tag, force }) => {
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
          await conf.requestUpdate({ tag })
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
    const updates = await conf.listUpdates()
    if (!updates.length) {
      logger.info(`no updates available`)
      return
    }

    if (updates.length === 1) {
      tag = updates[0].tag
      const { doUpdate } = await inquirer.prompt([{
        type: 'confirm',
        name: 'doUpdate',
        message: `Update to version "${tag}" ?`,
      }])

      if (!doUpdate) return
    } else {
      const result = await inquirer.prompt([{
        type: 'list',
        name: 'tag',
        message: 'Choose a version to update to',
        choices: updates.map(u => u.tag),
      }])

      tag = result.tag
    }
  }

  const applyUpdate = async ({ update }) => {
    // logger.info(`applying update with template: ${update.templateUrl}`)
    if (true) {
      // logger.info('using current user role')
      await conf.applyUpdateAsCurrentUser(update)
    } else {
      // logger.info('using updateStack-lambdaRole')
      await conf.applyUpdateViaLambda(update)
    }

    await conf.waitForStackUpdate(stackId)
  }

  const ctx = await new Listr([
    {
      title: 'download update',
      task: async ctx => {
        ctx.resp = await getUpdateWithRetry(tag)
      }
    },
    {
      title: 'apply update (be patient, or else)',
      task: async ctx => {
        const { resp } = ctx
        if (!resp) return

        if (!force && resp.upToDate) {
          ctx.upToDate = true
          return
        }

        await applyUpdate(resp)
      }
    }
  ]).run()

  if (ctx.upToDate) {
    logger.info(`your MyCloud is already up to date!`)
  }
}
