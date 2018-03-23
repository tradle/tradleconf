import fs from 'fs'
import os from 'os'
import yn from 'yn'
// import execa from 'execa'
import inquirer from 'inquirer'
import { isValidProjectPath } from './utils'
import { Conf } from './types'

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
    conf = fs.readFileSync(`${os.homedir()}/.aws/config`, { encoding: 'utf8' })
  } catch (err) {
    return ['default']
  }

  const { profiles } = parseConf(conf)
  return profiles.includes('default') ? profiles : ['default'].concat(profiles)
}

export const init = (conf: Conf) => {
  const defaultWhen = answers => answers.overwriteEnv !== false
  return inquirer.prompt([
    {
      type: 'confirm',
      name: 'overwriteEnv',
      message: 'This will overwrite your .env file',
      when: () => fs.existsSync('./.env')
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
      name: 'stackName',
      message: 'Which Tradle stack will you be configuring?',
      when: defaultWhen,
      choices: async ({ awsProfile }) => {
        const stackInfos = await conf.getStacks(awsProfile)
        return stackInfos.map(({ name }) => name)
      }
    },
    {
      type: 'input',
      name: 'projectPath',
      message: '(optional) Enter the path to your local development environment (a clone of https://github.com/tradle/serverless). Press <Enter> to skip',
      when: defaultWhen,
      validate: local => {
        if (yn(local) && !isValidProjectPath(local)) {
          return 'Provided path doesn\'t contain a serverless.yml'
        }

        return true
      }
    }
  ])
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
