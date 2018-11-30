import path from 'path'
import _ from 'lodash'
import inquirer from 'inquirer'
import Listr from 'listr'
import promiseRetry from 'promise-retry'
import { toSortableTag, sortTags, compareTags } from 'lexicographic-semver'
import Errors from '@tradle/errors'
import {
  Conf,
  UpdateOpts,
  VersionInfo,
  GetUpdateInfoResp,
  ApplyUpdateOpts,
  CFParameterDef,
  ListrTask,
} from './types'

import { Errors as CustomErrors } from './errors'
import { logger } from './logger'
import { confirmOrAbort } from './prompts'
import {
  deriveParametersFromStack,
  getPromptForParameter,
  promptParameters,
  getBlanksForMissingParameters,
  createStack,
} from './restore'

import * as utils from './utils'
import { DOT } from './constants'
import * as fs from './fs'

const USE_CURRENT_USER_ROLE = true
const VERSION_MIN = '1.1.15'
const VERSION_V2 = '2.0.0'
const VERSION_V2_TRANS = '2.0.0-trans.0'
const isUpdatingToV2 = (fromTag: string, toTag: string) => {
  return compareTags(fromTag, VERSION_V2) < 0 && compareTags(toTag, VERSION_V2) >= 0
}

interface UpdateHelperOpts extends UpdateOpts {
  currentVersion: VersionInfo
  updates: VersionInfo[]
}

class Updater {
  private conf: Conf
  private opts: UpdateOpts
  private updates: VersionInfo[]
  private currentVersion: VersionInfo
  private targetTag: string
  private verb: string
  constructor({ conf, opts, currentVersion, updates }: {
    conf: Conf
    opts: UpdateOpts
    currentVersion?: VersionInfo
    updates?: VersionInfo[]
  }) {
    // if (opts.rollback) {
    //   throw new Error('rollback command not supported at the moment')
    // }

    this.conf = conf
    this.opts = opts
    this.currentVersion = currentVersion
    this.updates = updates
    this.targetTag = opts.tag
    this.verb = opts.rollback ? 'rollback' : 'update'
  }

  public update = async () => {
    const { targetTag, currentVersion, updates, opts } = this
    const { provider, rollback } = opts
    if (!currentVersion) {
      this.currentVersion = await this.conf.getCurrentVersion()
    }

    if (!updates) {
      this.updates = await this._loadUpdates()
    }

    if (targetTag && rollback) {
      const idx = this.updates.findIndex(_.matches({ tag: targetTag }))
      if (idx === -1) {
        const previousTags = updates.map(u => u.tag)
        // we don't know what versions are available yet
        throw new Error(`your MyCloud was never previously deployed with version ${targetTag}

Your previously deployed versions are (most recently deployed at the top):

${previousTags.join('\n')}`)
      }
    }

    return await this._update()
  }

  private _loadUpdates = async () => {
    const { conf, opts, currentVersion } = this
    const { rollback, provider } = opts
    const getUpdates = rollback
      ? conf.listPreviousVersions()
      : conf.listUpdates({ provider })

    let updates = await getUpdates
    updates = _.sortBy(updates, 'sortableTag')
    updates = updates.filter(u => u.tag !== currentVersion.tag)
    if (rollback) {
      updates = updates.reverse().filter(u => u.sortableTag < currentVersion.sortableTag)
    }

    return updates
  }

  private _loadTargetTag = async () => {
    // filter here, not above
    // because applyPrerequisiteTransitionTags needs to see all updates
    const { verb, updates, opts } = this
    const { rollback, showReleaseCandidates } = opts
    let choices = updates.slice()
    const noRC = !rollback && !showReleaseCandidates
    if (noRC) {
      choices = choices.filter(update => !(isReleaseCandidateTag(update.tag) || isTransitionReleaseTag(update.tag)))
    }

    if (!choices.length) {
      throw new Error(`no ${verb} available`)
    }

    let message
    if (rollback) {
      message = `Choose a version to roll back to (most recently deployed at the top)`
    } else {
      message = `Choose a version to update to`
    }

    const result = await inquirer.prompt([{
      type: 'rawlist',
      pageSize: Infinity,
      name: 'tag',
      message,
      choices: choices.map(({ tag }) => ({
        name: getChoiceTextForTag(tag),
        value: tag
      })),
    }])

    this.targetTag = result.tag
  }

  private _update = async () => {
    const { conf, opts, currentVersion, updates, verb } = this
    const {
      stackId,
      provider,
      showReleaseCandidates,
      force,
      rollback,
    } = opts

    if (compareTags(currentVersion.tag, VERSION_MIN) < 0) {
      throw new Error(`you have an old version of MyCloud which doesn't support the new update mechanism
  Please update manually this one time. See instructions on https://github.com/tradle/serverless`)
    }

    if (!this.targetTag) {
      await this._loadTargetTag()
    }

    if (isUpdatingToV2(currentVersion.tag, this.targetTag)) {
      logger.warnBold(`Updating to version ${this.targetTag} will require me to DELETE and RECREATE your stack

Your data should not be harmed in the process
`)
      await confirmOrAbort('Continue?', false)
    }

    const { cloudformation } = conf.client
    if (!rollback && currentVersion.templateUrl) {
      const currentParams = await utils.getStackParameters({ cloudformation, stackId })
      const paramsRelPath = `params-${currentVersion.tag}-${Date.now()}.json`
      const paramsAbsPath = path.resolve(process.cwd(), paramsRelPath)
      fs.write(paramsAbsPath, currentParams)
      logger.info(`
Updating! To roll back, run:

tradleconf update-manually --template-url "${currentVersion.templateUrl}" --stack-parameters "${paramsRelPath}"
`)
    }

    const tag = this.targetTag
    const tasks:ListrTask[] = [
      {
        title: `loading release ${tag}, grab a coffee`,
        task: async ctx => {
          let resp
          try {
            resp = await this._getUpdateWithRetry()
            if (!resp) return
          } catch (err) {
            Errors.ignore(err, CustomErrors.NotFound)
            throw new Error(`failed to fetch version ${tag}. If you're confident it exists, please try again.`)
          }

          const { update, upToDate } = resp
          ctx.upToDate = upToDate
          ctx.update = update as ApplyUpdateOpts
          ctx.willUpdate = force || rollback || !upToDate
        }
      },
      {
        title: 'checking for required transitional releases',
        skip: ctx => force || !ctx.willUpdate,
        task: async ctx => {
          await this._applyPrerequisiteTransitionTags()
        }
      },
      {
        title: `checking for any required transitional changes`,
        skip: ctx => !ctx.willUpdate,
        task: async ctx => {
          const { update } = ctx
          const v1ToV2 = await this._maybeTransitionV1ToV2({ update, stackId })
          if (v1ToV2) {
            ctx.willUpdate = false
            ctx.willRecreate = true
            // throw new Error(`you'll need to destroy your stack (but keep the resources) and update manually to: ${update.templateUrl}`)
          }
        }
      },
      {
        title: 'killing and resurrecting',
        skip: ctx => !ctx.willRecreate,
        task: async ctx => {
          const update = ctx.update as ApplyUpdateOpts
          const { parameters, templateUrl, notificationTopics } = update
          const { region, stackName } = utils.parseStackArn(stackId)

          logger.info(`if the the process is interrupted after the original stack is deleted, restore manually using:

tradleconf restore-stack --template-url "${templateUrl}"`)
          await utils.deleteStackAndWait({ cloudformation, params: { StackName: stackId } })
          ctx.newStackArn = await createStack({
            region,
            templateUrl,
            profile: this.opts.profile,
            stackName,
            parameters,
            notificationTopics,
          })
        }
      },
      {
        title: `triggering update`,
        skip: ctx => !ctx.willUpdate,
        task: async ctx => {
          const update = ctx.update as ApplyUpdateOpts
          try {
            await this._triggerUpdate(update)
          } catch (err) {
            if (err.code === 'ValidationError' && err.message.includes('UPDATE_IN_PROGRESS')) {
              throw new Error('stack is currently updating, please wait for it to finish before applying another update')
            }

            throw err
          }
        }
      },
      {
        title: `waiting for ${verb} to complete, be patient, or else`,
        skip: ctx => !ctx.willUpdate,
        task: async ctx => {
          try {
            await conf.waitForStackUpdate({ stackId })
          } catch (err) {
            if (err.code === 'ResourceNotReady') {
              throw new Error(`failed to apply ${verb}`)
            }

            throw err
          }
        }
      }
    ]

    let ctx:any = {}
    for (const { title, skip, task } of tasks) {
      if (skip && skip(ctx)) continue

      logger.info(`${DOT} ${title}...`)
      await task(ctx)
    }

    if (ctx.upToDate && !ctx.willUpdate) {
      if (tag === currentVersion.tag) {
        throw new Error(`your MyCloud is already up to date!`)
      }

      this._throwBackwardsError()
    }

    return {
      updated: ctx.willUpdate,
      recreated: ctx.willRecreate,
      newStackArn: ctx.newStackArn,
    }
  }

  private _maybeTransitionV1ToV2 = async ({ stackId, update }: {
    stackId: string
    update: ApplyUpdateOpts
  }) => {
    const { conf } = this
    const { cloudformation } = conf.client
    const isV1Stack = await utils.isV1Stack({ cloudformation, stackId })
    if (!isV1Stack) return

    const parameters = await this._getV1ToV2Parameters({ stackId, update })
    if (!parameters) return

    update.parameters = parameters
    return true
  }

  private _getV1ToV2Parameters = async ({ stackId, update }: {
    stackId: string
    update: ApplyUpdateOpts
  }) => {
    const { conf } = this
    const { client } = conf
    const { cloudformation } = conf.client
    const [parameters, currentTemplate, newTemplate] = await Promise.all([
      deriveParametersFromStack({ client, stackId }),
      utils.getStackTemplate({ cloudformation, stackId }),
      utils.get(update.templateUrl),
    ])

    if (!utils.isV2Template(newTemplate)) return

    const missing = await getBlanksForMissingParameters({ template: newTemplate, parameters })
    return parameters.concat(missing)
  }

  private _throwBackwardsError = () => {
    const { currentVersion, targetTag } = this
    throw new Error(`your MyCloud is of a more recent version: ${currentVersion.tag}

To force deploy ${targetTag}, run: tradleconf update --tag ${targetTag} --force`)
  }

  private _getUpdateWithRetry = async ():Promise<GetUpdateInfoResp> => {
    const tag = this.targetTag
    const { conf, opts } = this
    const { provider } = opts
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

  private _applyPrerequisiteTransitionTags = async () => {
    const { updates, currentVersion, targetTag } = this
    const idx = updates.findIndex(update => update.tag === targetTag)
    const updatesBeforeTag = idx === -1 ? updates : updates.slice(0, idx)
    const transition = updatesBeforeTag.find(update => isTransitionReleaseTag(update.tag))
    if (!transition) {
      // extra safety check
      if (isUpdatingToV2(currentVersion.tag, targetTag) && compareTags(currentVersion.tag, VERSION_V2_TRANS) < 0) {
        throw new Error(`please run this first: tradleconf update --tag ${VERSION_V2_TRANS}`)
      }

      return
    }

    logger.warnBold(`you must apply the transition version first: ${transition.tag}`)
    await confirmOrAbort(`apply transition tag ${transition.tag} now?`)
    await update(this.conf, {
      ...this.opts,
      force: true,
      tag: transition.tag,
      currentVersion,
      updates,
    })
  }

  private _triggerUpdate = async (update: ApplyUpdateOpts) => {
    const { conf } = this
    if (USE_CURRENT_USER_ROLE) {
      await conf.applyUpdateAsCurrentUser(update)
    } else {
      throw new CustomErrors.InvalidInput(`updating via lambda is not supported`)
      // await conf.applyUpdateViaLambda(update)
    }
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

export const update = (
  conf: Conf,
  opts: UpdateOpts|UpdateHelperOpts
) => new Updater({ conf, opts }).update()

export const getDefaultUpdateParameters = async ({ cloudformation, stackId, templateUrl }: {
  cloudformation: AWS.CloudFormation
  stackId: string
  templateUrl: string
}) => {
  const reused = await utils.getReuseParameters({ cloudformation, stackId })
  const { bucket } = utils.parseS3Url(templateUrl)
  const source = reused.find(p => p.ParameterKey === 'SourceDeploymentBucket')
  if (source) {
    delete source.UsePreviousValue
    source.ParameterValue = bucket
  }

  return reused
}
