import fs from 'fs'
import path from 'path'
import os from 'os'
// import execa from 'execa'
import inquirer from 'inquirer'
import models from '@tradle/models-cloud'
import Errors from '@tradle/errors'
import { Errors as CustomErrors } from './errors'
import { logger } from './logger'
import {
  isValidProjectPath,
  doKeyPairsExist,
  listKeyPairs,
  listAZs,
  isMyCloudStackName,
} from './utils'

import { Conf, AWSClients, Choice } from './types'

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

const isVirginConfiguration = () => {
  const confDir = path.resolve(process.cwd(), 'conf')
  if (!fs.existsSync(confDir)) return true

  const local = fs.readdirSync(confDir)
  return !local.length
}

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
  if (fs.existsSync('./.env')) {
    await confirmOrAbort('This will overwrite your .env file')
  }

  const haveRemote = await confirm('Have you already deployed your MyCloud to AWS?')
  const getLocal:PromptList = [
    {
      type: 'confirm',
      name: 'haveLocal',
      message: 'Do you have a local development environment? (a clone of https://github.com/tradle/serverless)',
    },
    {
      type: 'input',
      name: 'projectPath',
      message: 'Enter the path to your local development environment (a clone of https://github.com/tradle/serverless)',
      when: answers => answers.haveLocal,
      validate: local => {
        if (!isValidProjectPath(local)) {
          return 'Provided path doesn\'t contain a serverless.yml, please try again'
        }

        return true
      }
    }
  ]

  if (!haveRemote) {
    return {
      haveRemote,
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
      choices: async ({ region, awsProfile }) => {
        const stackInfos = await conf.getStacks({
          profile: awsProfile,
          region
        })

        if (!stackInfos.length) {
          throw new Error('no stacks found')
        }

        return stackInfos
          .filter(({ name }) => isMyCloudStackName(name))
          .map(({ name, id }) => ({
            name,
            value: { name, id }
          }))
      }
    },
  ]
  .concat(getLocal)
  .concat({
    type: 'confirm',
    name: 'loadCurrentConf',
    message: 'Would you like to pull your current configuration?',
    when: isVirginConfiguration,
  } as any)

  return {
    haveRemote,
    ...(await inquirer.prompt(getRemoteAndLocal))
  }
}

// export const getKeyPair = (aws: AWSClients, message: string) => {
//   return inquirer.prompt([
//     {
//       type: 'list',
//       name: 'keyPair',
//       message,
//       choices: listKeyPairs(aws, )
//     }
//   ])
//   .then(({ keyPair }) => keyPair)
// }

export const fn = (conf: Conf, message: string) => {
  return inquirer.prompt([
    {
      type: 'list',
      name: 'fn',
      message,
      choices: conf.getFunctionShortNames
    }
  ])
  .then(({ fn }) => fn)
}

export const confirm = (message: string, defaultValue=true) => {
  return inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirm',
      message,
      default: defaultValue,
    }
  ])
  .then(({ confirm }) => confirm)
}

export const confirmOrAbort = async (msg:string, defaultValue?:boolean) => {
  const confirmed = await confirm(msg, defaultValue)
  if (!confirmed) {
    throw new CustomErrors.UserAborted()
  }
}

type SyncValidate = (str: string) => boolean

export const ask = (message: string, validate?: SyncValidate) => {
  return inquirer.prompt([
    {
      type: 'input',
      name: 'answer',
      message,
      validate,
    }
  ])
  .then(({ answer }) => answer)
}

export const chooseEC2KeyPair = async (client: AWSClients) => {
  const know = await confirm('Do you know the name of the EC2 key pair you want to use?')
  if (know) {
    const key = await ask('What is the name of the EC2 key pair you configured in AWS?')
    const exists = await doKeyPairsExist(client, [key])
    if (exists) return key

    logger.warn(`Key pair not found in region ${client.region}`)
    return chooseEC2KeyPair(client)
  }

  const keyPairs = await listKeyPairs(client)
  if (!keyPairs.length) {
    throw new CustomErrors.InvalidInput(`No key pairs found in region: ${client.region}`)
  }

  return choose({
    message: 'Choose the key pair to set up for SSH access',
    choices: keyPairs,
  })
}

export const choose = async ({ message, choices, defaultValue }: {
  message: string
  choices: Function|any[]
  defaultValue?: string
}) => {
  return inquirer.prompt([
    {
      type: 'list',
      name: 'choice',
      message,
      choices: typeof choices === 'function' ? choices : () => choices,
      default: defaultValue,
    }
  ])
  .then(({ choice }) => choice)
}

export const chooseRegion = async (opts?: {
  default?: string
  message?: string
}) => {
  const message = opts && opts.message || 'Choose a deployment region'
  return choose({
    message,
    choices: regions,
    defaultValue: opts && opts.default,
  })
}

export const chooseMultiple = async({ min, max, choices, message }: {
  min: number
  max: number
  choices: Choice[]
  message: string
}) => {
  return inquirer.prompt([
    {
      type: 'checkbox',
      choices,
      name: 'answer',
      message,
      validate: (choices) => {
        if (choices.length < min || choices.length > max) {
          throw new Error(message)
        }

        return true
      }
    }
  ])
  .then(({ answer }) => answer)
}

export const chooseAZs = async (client: AWSClients, { region, count }: {
  region: string
  count: number
}) => {
  const azs = await listAZs({ region })
  if (azs.length === count) return azs

  return chooseMultiple({
    min: count,
    max: count,
    message: `Choose ${count} availability zones`,
    choices: azs.map(name => ({ name, value: name })),
  })
}
