#!/usr/bin/env node

require('source-map-support').install()

// @ts-ignore
process.env.AWS_SDK_LOAD_CONFIG = true

import updateNotifier from 'update-notifier'
import * as Errors from '@tradle/errors'
import { Errors as CustomErrors } from './errors'
import { logger, colors, chalk } from './logger'
import { Conf, ConfOpts, NodeFlags } from './types'

const pkg = require('../package.json')
const DESC = {
  key: 'key returned by create-data-bundle command'
}

updateNotifier({
  pkg,
  updateCheckInterval: 60 * 60 * 1000 // 1 hr
}).notify({ isGlobal: true })

require('dotenv').config({
  path: '.env'
})

import _ from 'lodash'
import {
  prettify,
  isValidProjectPath,
  normalizeConfOpts,
  isSafeRemoteCommand,
  isRemoteOnlyCommand,
  toCamelCase,
} from './utils'

const printHelp = () => {
  matchedCommand = helpCommand
  const commands = program.commands
    .filter(c => c.description())

  logger.info(
    commands
      .map(c => `${c.name()}\n\n${getCommandHelp(c)}`)
      .join('\n\n')
  )
}

const getCommandHelp = c => {
  const desc = c.description()
  return desc
    .split('\n')
    .map(line => `  ${line}`)
    .join('\n')
}

const getCommandName = command => {
  if (typeof command === 'string') return command

  return command && command.name()
}

const NODE_OPTS = {
  'inspect': ['--$', 'activate lamba inspector on host:port (default: 127.0.0.1:9229)', '[[host:]port]'],
  'inspect-brk': ['--$', 'activate lamba inspector on host:port and break at start of user script', '[[host:]port]'],
  'inspect-port': ['--$ <[host]:port>', 'set host:port for lamba inspector'],
  'inspect-publish-uid': ['--$ <uid>', 'comma separated list of destinations for lamba inspector uid(default:stderr,http)'],
  'debug': ['--$', 'activate *legacy* lamba inspector on host:port (default: 127.0.0.1:9229)', '<[host:]port>'],
  'debug-brk': ['--$', 'activate *legacy* lamba inspector on host:port and break at start of user script', '<[host:]port>'],
  'debug-port': ['--$ <[host]:port>', 'set host:port for lamba inspector'],
}
const PROGRAM_OPTS = {
  'local': ['-l, --$', 'target local development environment'],
  'remote': ['-r, --$', ' target remote environment'],
  'project': ['-x, --$ [path]', ' path to serverless project on disk'],
  ...NODE_OPTS
}

const NODE_FLAGS = Object.keys(NODE_OPTS)

let matchedCommand

const getTargetEnvironmentWarning = (commandName: string, confOpts: ConfOpts) => {
  const warning = []
  const target = confOpts.remote ? 'remote' : 'local'
  if (!isRemoteOnlyCommand(commandName)) {
    warning.push(`Targeting ${chalk.bold(target.toUpperCase())} environment`)
  }

  if (confOpts.remote && confOpts.project) {
    if (!isRemoteOnlyCommand(commandName)) {
      warning.push('To target the local environment, specify --local or -l')
    }
  } else if (confOpts.remote === false) {
    warning.push('To target the remote environment, specify --remote or -r')
  }

  return warning.length ? warning.join('. ') : ''
}

const assertRequiredOptions = command => {
  const omittedRequired = []
  command.options.forEach((option) => {
    const name = option.long.slice(2)
    if (option.required && !command.hasOwnProperty(toCamelCase(name, '-'))) {
      omittedRequired.push(`--${name}`)
    }
  })

  if (omittedRequired.length !== 0) {
    throw new Error(`expected option(s): ${omittedRequired.join(', ')}`)
  }
}

function lowerCamel (input) {
  const parts = input.split('-')
  for (let i = 1; i < parts.length; i++) {
    parts[i] = parts[i][0].toUpperCase() + parts[i].slice(1)
  }
  return parts.join('')
}

function getOpt (name) {
  const lcName = lowerCamel(name)
  return program[lcName] || defaults.confOpts[lcName]
}

const normalizeOpts = (...args) => {
  const command = matchedCommand = args.pop()

  assertRequiredOptions(command)

  let confOpts: ConfOpts = Object.entries(PROGRAM_OPTS).reduce((opts, [name, [_template, _docs, optionalArg]]) => {
    let value = getOpt(name)
    if (optionalArg) {
      value = getOpt(`${name}-value`) || value
    }
    if (value !== undefined && value !== false) {
      opts[name] = value
    }
    return opts
  }, {})

  const commandName = getCommandName(command)
  if (typeof confOpts.remote !== 'boolean' &&
    typeof confOpts.local !== 'boolean' &&
    isSafeRemoteCommand(commandName)) {
    confOpts.remote = true
  }

  confOpts = normalizeConfOpts({
    ..._.omit(confOpts, NODE_FLAGS),
    nodeFlags: _.pick(confOpts, NODE_FLAGS) as NodeFlags
  })

  const warning = getTargetEnvironmentWarning(commandName, confOpts)
  if (warning) {
    logger.warn(warning + '\n')
  }

  const commandOpts = _.pick(command, command.options.map(o => o.attributeName()))
  commandOpts.args = args
  return { commandOpts, confOpts }
}

const createAction = (action: keyof Conf) => (...args) => {
  let normalized
  try {
    normalized = normalizeOpts(...args)
  } catch (err) {
    logger.error(err.message)
    return
  }

  const { confOpts, commandOpts } = normalized
  return run(() => {
    const conf: Conf = createConf(confOpts)
    if (!conf[action]) {
      throw new CustomErrors.InvalidInput(`conf method not found: ${action}`)
    }

    // @ts-ignore
    return conf[action](commandOpts)
  })
}

const run = async (fn) => {
  let result
  try {
    result = await fn()
  } catch (err) {
    process.exitCode = 1
    if (Errors.matches(err, 'developer')) {
      logger.error(err.stack)
    } else if (Errors.matches(err, CustomErrors.UserAborted)) {
      logger.info('command canceled')
    } else {
      const { name = 'Error', message } = err
      logger.error(`${name}: ${message}`)
        ; (matchedCommand || program).outputHelp()
    }

    process.exit()
    return
  }

  if (result == null) {
    // logger.info('OK')
  } else {
    // write to stdout, unlike all other logging
    console.log(prettify(result))
  }
}

const program = require('commander')
program
  .version(pkg.version)

for (const [opt, [keyTemplate, docs, optionalArg]] of Object.entries(PROGRAM_OPTS)) {
  program.option((keyTemplate as string).replace('$', opt), docs)
  if (optionalArg) {
    // commander has a limitation that doesnt allow us to have an optional field that may be boolean or
    // contain a value and subcommands.
    program.option(`${(keyTemplate as string).replace('$', `${opt}-value`)} ${optionalArg}`)
  }
}
program.allowUnknownOption(true)

program.on('--help', () => logger.warn('\nuse the `help` command to get command-specific help'))
if (!process.argv.slice(2).length) {
  program.outputHelp()
}

// pre-parse to determine which env vars to load, local or remote
program.parse(process.argv)
const defaults = {
  confOpts: {
    stackName: process.env.stackName,
    stackId: process.env.stackId,
    profile: process.env.awsProfile,
    region: process.env.region,
    namespace: process.env.namespace,
    project: process.env.project
  }
}

const {
  profile = defaults.confOpts.profile,
  region = defaults.confOpts.region,
} = program

if (profile) {
  process.env.AWS_PROFILE = profile
}

if (region) {
  process.env.AWS_REGION = region
}

const deployCommand = program
  .command('deploy')
  .description(`push your local configuration`)
  .option('-m, --models', 'deploy models and lenses')
  .option('-s, --style', 'deploy style')
  .option('-t, --terms', 'deploy terms')
  .option('-b, --bot', 'deploy bot configuration')
  .option('-a, --all', 'deploy all configuration')
  .option('--dry-run', 'print but don\'t execute')
  .allowUnknownOption(false)
  .action(createAction('deploy'))

const loadCommand = program
  .command('load')
  .description(`load the currently deployed configuration`)
  .option('-m, --models', 'load models and lenses')
  .option('-s, --style', 'load style')
  .option('-t, --terms', 'load terms')
  .option('-b, --bot', 'load bot configuration')
  .option('-a, --all', 'load all configuration')
  .option('--dry-run', 'print but don\'t execute')
  .action(createAction('load'))

const validateCommand = program
  .command('validate')
  .description(`[DEPRECATED] validate your local configuration before you push it

This command is deprecated. Validation is done cloud-side regardless.`)
  .option('-m, --models', 'validate models and lenses')
  .option('-s, --style', 'validate style')
  .option('-t, --terms', 'validate terms')
  .option('-b, --bot', 'validate bot configuration')
  .option('-a, --all', 'validate all configuration')
  .allowUnknownOption(false)
  .action(createAction('validate'))

const createDataBundleCommand = program
  .command('create-data-bundle')
  .description(`upload a data bundle`)
  .option('-p, --path <path>', 'path to bundle to create')
  .allowUnknownOption(false)
  .action(createAction('createDataBundle'))

const createDataClaimCommand = program
  .command('create-data-claim')
  .description(`create a claim stub for a data bundle`)
  .option('-k, --key <key>', DESC.key)
  .option('-c, --claim-type <claimType>', '"prefill" or "bulk"')
  .option('-q, --qr-code [pathToWriteQRCode]', 'path to write QR code, e.g. ./myqrcode.png')
  .allowUnknownOption(false)
  .action(createAction('createDataClaim'))

const getDataBundleCommand = program
  .command('get-data-bundle')
  .description(`get a data bundle by its claimId and key`)
  .option('-c, --claim-id <claimId>', 'claim id returned by create-data-claim command')
  .option('-k, --key <key>', DESC.key)
  .allowUnknownOption(false)
  .action(createAction('getDataBundle'))

const listDataClaimsCommand = program
  .command('list-data-claims')
  .description(`list existing claim stubs for data bundles`)
  .option('-k, --key <key>', DESC.key)
  .allowUnknownOption(false)
  .action(createAction('listDataClaims'))

const initCommand = program
  .command('init')
  .description(`initialize your local configuration (re-generate your .env file)`)
  // .option('-p, --profile <profile>', 'the AWS profile name, if you know it')
  // .option('-s, --stack-name <stackName>', `your MyCloud's stack name in AWS, if you know it`)
  .allowUnknownOption(false)
  .action(createAction('init'))

const execCommand = program
  .command('exec <command>')
  .description(`execute a command on the remote cli`)
  .allowUnknownOption(false)
  .action(createAction('exec'))

const invokeCommand = program
  .command('invoke')
  .description(`invoke a function`)
  .option('-f, --function-name <functionName>', 'invoke a lambda by name')
  .allowUnknownOption(false)
  .action(createAction('invoke'))

const destroyCommand = program
  .command('destroy')
  .description(`destroy your deployment`)
  .option('--profile [awsProfileName]', 'defaults to awsProfile in .env')
  .option('--stack-arn [arn]', 'defaults to stackId in .env')
  .allowUnknownOption(false)
  .action(createAction('destroy'))

const infoCommand = program
  .command('info')
  .description(`get some app links and other basic info for your deployment`)
  .allowUnknownOption(false)
  .action(createAction('info'))

const disableCommand = program
  .command('disable')
  .description(`disable your stack (turn off the lambdas)`)
  .allowUnknownOption(false)
  .action(createAction('disable'))

const enableCommand = program
  .command('enable')
  .description(`enable your stack (turn on the lambdas)`)
  .allowUnknownOption(false)
  .action(createAction('enable'))

const balanceCommand = program
  .command('balance')
  .description(`check the balance on your blockchain key`)
  .allowUnknownOption(false)
  .action(createAction('balance'))

const versionCommand = program
  .command('get-current-version')
  .description(`check your current MyCloud version`)
  .allowUnknownOption(false)
  .action(createAction('getCurrentVersion'))

const listPreviousVersionsCommand = program
  .command('list-previous-versions')
  .description('list previous versions of your MyCloud deployment')
  .allowUnknownOption(false)
  .action(createAction('listPreviousVersions'))

const updateCommand = program
  .command('update')
  .option('-t, --tag [versionTag]')
  .option('-f, --force', 'force update even if deployment is ahead of or equal to the specified version tag')
  .option('-c, --show-release-candidates', 'set if you want to list release candidate versions')
  .option('-p, --provider [providerPermalink]', 'if you want to update from someone other than Tradle')
  .description('update your MyCloud')
  .allowUnknownOption(false)
  .action(createAction('update'))

const updateToLatest = program
  .command('update-to-latest')
  .option('--minor', 'limit updates to patches and minor versions')
  .option('--patch', 'limit updates to patches')
  .option('-c, --include-release-candidates', 'include release candidate versions')
  .description('update your MyCloud to the latest available version')
  .allowUnknownOption(false)
  .action(createAction('updateToLatest'))

const updateManuallyCommand = program
  .command('update-manually')
  .option('-t, --template-url [templateUrl]', 'stack template url. Defaults to reuse currently deployed template')
  .option('-p, --stack-parameters [filePath]', 'path to parameters json file')
  .description('[ADVANCED] update your MyCloud to a given stack template')
  .allowUnknownOption(false)
  .action(createAction('updateManually'))

const rollbackCommand = program
  .command('rollback')
  .option('-t, --tag <versionTag>')
  .option('-c, --show-release-candidates', 'set if you want to list release candidate versions')
  // .option('-p, --provider <providerPermalink>', 'if you want to update from someone other than Tradle')
  .description('roll your MyCloud back to a version you previously deployed')
  .allowUnknownOption(false)
  .action(createAction('rollback'))

// const requestUpdateCommand = program
//   .command('request-update')
//   .option('-t, --tag <versionTag>')
//   // .option('-p, --provider <providerPermalink>', 'if you want to update from someone other than Tradle')
//   .description('request an update for a given version')
//   .allowUnknownOption(false)
//   .action(createAction('requestUpdate'))

const listUpdatesCommand = program
  .command('list-updates')
  .option('-p, --provider [providerPermalink]', 'if you want to list updates from someone other than Tradle')
  .description('list available updates for your MyCloud')
  .allowUnknownOption(false)
  .action(createAction('listUpdates'))

const createLogCommand = (command, name) => command
  .allowUnknownOption(false)
  .option('-s, --start [time-expression]', 'see awslogs docs')
  .option('-e, --end [time-expression]', 'see awslogs docs')
  .option('-w, --watch', 'tail log')
  .option('-t, --timestamp', 'prints the creation timestamp of each event.')
  .option('-i, --ingestion-time', 'prints the ingestion time of each event.')
  .option('-f, --filter-pattern [filter-pattern]', 'CloudWatch Logs filter pattern')
  .option('-q, --query [query]', 'CloudWatch Logs query pattern')
  .action(createAction(name))

const logCommand = createLogCommand(program
  .command('log [functionName]')
  .description(`view / follow a function's logs.

Passes options through to awslogs (https://github.com/jorgebastida/awslogs)

Make sure to put spaces between options.

Right: tradleconf log oniotlifecycle -s 1d
Wrong: tradleconf log oniotlifecycle -s1d

`), 'log')

const tailCommand = createLogCommand(program
  .command('tail [functionName]')
  .description(`tail a function's logs. Equivalent to log -w`), 'tail')

const graphiqlCommand = program
  .command('graphiql')
  .description('open GraphiQL in the browser')
  .allowUnknownOption(false)
  .action(run.bind(null, async () => {
    matchedCommand = graphiqlCommand
    const { apiBaseUrl } = process.env
    if (!apiBaseUrl) {
      throw new Error('did you forget to run init?')
    }

    await require('opn')(`${apiBaseUrl}/graphql`, { wait: false })
  }))

const setKYCServices = program
  .command('set-kyc-services')
  .option('--trueface-spoof', 'enable / disable TrueFace Spoof')
  .option('--rank-one', 'enable / disable RankOne')
  .option('--idrnd-liveface', 'enable / disable IDRND LiveFace')
  .option('--param-instance-type [instanceType]', 'EC2 instance type (default: m5.xlarge')
  .allowUnknownOption(false)
  .action(createAction('setKYCServices'))

const enableKYCServices = program
  .command('enable-kyc-services')
  .option('--param-instance-type [instanceType]', 'EC2 instance type (default: m5.xlarge')
  .allowUnknownOption(false)
  .action(createAction('enableKYCServices'))

// const updateKYCServices = program
//   .command('update-kyc-services')
//   .allowUnknownOption(false)
//   .action(createAction('updateKYCServices'))

const disableKYCServices = program
  .command('disable-kyc-services')
  .option('--services-stack-arn [arn]', 'set if you know the ARN of the KYC services stack')
  .allowUnknownOption(false)
  .action(createAction('disableKYCServices'))

const reboot = program
  .command('reboot')
  .description(`reboot your MyCloud functions, in case they are misbehaving.
This creates ~20-30 seconds of downtime but doesn't affect any data.`)
  .allowUnknownOption(false)
  .action(createAction('reboot'))

const getTemplate = program
  .command('get-stack-template')
  .option('-o, --output <file-path>', 'output file path')
  .description(`download your stack template`)
  .allowUnknownOption(false)
  .action(createAction('getStackTemplate'))

const restoreFromStack = program
  .command('restore-stack')
  .option('--new-stack-name [name]', 'name to use for new stack')
  .option('--source-stack-arn [stackArn]', 'arn of stack to restore. Defaults to the one in your .env file')
  .option('--template-url [templateUrl]', 'if you want to restore the stack to a different version that it was last at')
  .option('--stack-parameters [path/to/parameters.json]', 'if you generated parameters with the "gen-stack-parameters" command')
  // .option('--new-stack-region <region>', 'region to launch new stack in')
  .description(`create a new stack from an existing stack, using the same tables, buckets, and identity`)
  .allowUnknownOption(false)
  .action(createAction('restoreFromStack'))

// const createStack = program
//   .command('create-stack')
//   .option('--stack-parameters <pathToParams>', 'path to parameters file you generated with the "gen-stack-parameters" command')
//   .option('--template-url <templateUrl>', 'stack template url')
//   // .option('--new-stack-region <region>', 'region to launch new stack in')
//   .description(`create a new stack from an existing stack, using the same tables, buckets, and identity`)
//   .allowUnknownOption(false)
//   .action(createAction('createStack'))

const genParams = program
  .command('gen-stack-parameters')
  .option('--source-stack-arn [stackArn]', 'defaults to the one in your .env file')
  .option('--output <filePath>', 'path to write generated parameters file')
  .option('--as-object', 'if you prefer the result as a key-value (you probably don\'t)')
  .description('generate parameters for creating/updating a stack')
  .allowUnknownOption(false)
  .action(createAction('genStackParameters'))

const restoreBucket = program
  .command('restore-bucket')
  .option('--source-name <bucketName>', 'bucket to copy files from')
  .option('--dest-name <bucketName>', 'bucket to copy files to')
  .option('--date <isoDate>', 'point in time to restore to')
  .description(`clone "source" bucket's state at a point in time to "dest" bucket`)
  .allowUnknownOption(false)
  .action(createAction('restoreBucket'))

const restoreTable = program
  .command('restore-table')
  .option('--source-name <tableName>', 'table to copy')
  .option('--dest-name <tableName>', 'table to create with the source table\'s content')
  .option('--date <isoDate>', 'point in time to restore to')
  .description(`clone "source" table's state at a point in time to "dest" table`)
  .allowUnknownOption(false)
  .action(createAction('restoreTable'))

const restoreResources = program
  .command('restore-resources')
  .option('--date <isoDate>', 'point in time to restore to')
  .option('--output <filePath>', 'path to write generated parameters file')
  .description(`clone buckets (except logs bucket) and tables at the specified point in time`)
  .allowUnknownOption(false)
  .action(createAction('restoreResources'))

const setSealingMode = program
  .command('set-sealing-mode')
  .option('--mode <sealingMode>', '"single" or "batch"')
  .option('--period-in-minutes [period]', 'only relevant in "batch" mode. Example: set "5" to seal every 5 minutes')
  .description(`clone buckets (except logs bucket) and tables at the specified point in time`)
  .allowUnknownOption(false)
  .action(createAction('setSealingMode'))

const setAdminEmail = program
  .command('set-admin-email')
  .option('--email <email>')
  .description(`AWS admin email address, for various alerts`)
  .allowUnknownOption(false)
  .action(createAction('setAdminEmail'))

const setDBAutoscaling = program
  .command('set-db-autoscaling')
  .option('--on-demand', 'cheaper for small to medium load')
  .option('--provisioned', 'cheaper for high load')
  .description(`set DynamoDB autoscaling style`)
  .allowUnknownOption(false)
  .action(createAction('setDBAutoscaling'))

const setLogsTransition = program
  .command('set-logs-transition')
  .option('--days <days>', 'days before logs are transitioned to Glacier')
  .description(`set logs persistance duration`)
  .allowUnknownOption(false)
  .action(createAction('setLogsTransition'))

const setLogsTTL = program
  .command('set-logs-ttl')
  .option('--days <days>', 'days before logs are deleted forever')
  .description(`set logs persistance duration`)
  .allowUnknownOption(false)
  .action(createAction('setLogsTTL'))

const setStackParameters = program
  .command('set-stack-parameters')
  .option('--parameters <key1=value1,key2=value2>', 'set stack parameters (advanced users)')
  .description(`set logs persistance duration`)
  .allowUnknownOption(false)
  .action(createAction('setStackParameters'))

const createQRCode = program
  .command('qr')
  .option('-o, --output <output>', 'output file path')
  .option('--host [host]', 'provider host, e.g. http://localhost:21012')
  .option('--permalink [permalink]', 'provider permalink')
  .description(`generate a qr code for adding a provider`)
  .allowUnknownOption(false)
  .action(createAction('createQRCode'))

// require AWS sdk after env variables are set
const AWS = require('aws-sdk')
const { createConf } = require('./')
// re-parse with env vars set

const helpCommand = program
  .command('help')
  .action(printHelp)

program.parse(process.argv)
// if (typeof parseResult.args[0] === 'string') {
if (!matchedCommand) {
  logger.error(`command not found with name: ${process.argv[2]}`)
}
