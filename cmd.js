#!/usr/bin/env node

process.env.AWS_SDK_LOAD_CONFIG = true

const updateNotifier = require('update-notifier')
const co = require('co')
const Errors = require('@tradle/errors')
const CustomErrors = require('./lib/errors')
const logger = require('./lib/logger')
const pkg = require('./package.json')
const DESC = {
  key: 'key returned by create-data-bundle command'
}

updateNotifier({
  pkg,
  updateCheckInterval: 60 * 60 * 1000 // 1 hr
}).notify()

require('dotenv').config({
  path: '.env'
})

const _ = require('lodash')
const { debug, prettify, isValidProjectPath } = require('./lib/utils')
const HELP = `
  Commands:
    validate
    load
    deploy
    create-data-bundle
    create-data-claim

  To get help for a command, use --help, e.g.: tradleconf validate --help
`

const printHelp = () => logger.info(HELP)
const getCommandName = command => {
  if (typeof command === 'string') return command

  return command && command.name()
}

const NODE_FLAGS = [
  'debug',
  'debug-brk'
]

const PROGRAM_OPTS = [
  'profile',
  'local',
  'remote',
  'project'
].concat(NODE_FLAGS)

let matchedCommand

const normalizeOpts = (...args) => {
  const command = matchedCommand = args.pop()
  const programOpts = _.defaults(_.pick(program, PROGRAM_OPTS), defaults.programOpts)
  if (program.debugBrk) {
    programOpts['debug-brk'] = true
  }

  const { local, remote } = programOpts
  if (command.name() !== 'validate') {
    const envType = local ? 'local' : 'remote'
    debug(`targeting ${envType} environment`)
  }

  const commandOpts = _.pick(command, command.options.map(o => o.attributeName()))
  commandOpts.args = args
  return {
    commandOpts,
    programOpts: _.extend(_.omit(programOpts, NODE_FLAGS), {
      lambda: new AWS.Lambda(),
      nodeFlags: _.pick(programOpts, NODE_FLAGS)
    })
  }
}

const createAction = action => (...args) => {
  const { programOpts, commandOpts } = normalizeOpts(...args)
  return run(() => {
    const conf = new Conf(programOpts)
    return conf[action](commandOpts)
  })
}

const run = co.wrap(function* (fn) {
  let result
  try {
    result = yield fn()
  } catch (err) {
    process.exitCode = 1
    if (Errors.matches(err, 'developer')) {
      logger.error(err.stack)
    } else if (Errors.matches(err, CustomErrors.UserAborted)) {
      logger.info('command canceled')
    } else {
      logger.error(err.message)
      ;(matchedCommand || program).outputHelp()
    }

    return
  }

  if (result == null) {
    logger.info('OK')
  } else {
    logger.info(prettify(result))
  }
})

const program = require('commander')
program
  .version(pkg.version)
  .option('-p, --profile', 'AWS profile to use')
  .option('-l, --local', 'target local development environment')
  .option('-r, --remote', 'target remote environment')
  .option('-x, --project [path]', 'path to serverless project on disk')
  .option('--debug', 'invoke serverless function under the debugger')
  .option('--debug-brk', 'invoke serverless function under the debugger')

program.on('--help', printHelp)
if (!process.argv.slice(2).length) {
  program.outputHelp()
}

// pre-parse to determine which env vars to load, local or remote
program.parse(process.argv)
const defaults = {
  programOpts: {
    stackName: process.env.stackName,
    profile: process.env.awsProfile,
    project: process.env.project
  }
}

const { profile=defaults.programOpts.profile } = program
if (profile) {
  process.env.AWS_PROFILE = profile
}

const deployCommand = program
  .command('deploy')
  // .description('deploy ')
  .option('-m, --models', 'deploy models')
  .option('-s, --style', 'deploy style')
  .option('-t, --terms', 'deploy terms')
  .option('-b, --bot', 'deploy bot configuration')
  .option('-a, --all', 'deploy all configuration')
  .option('--dry-run', 'print but don\'t execute')
  .allowUnknownOption(false)
  .action(createAction('deploy'))

const loadCommand = program
  .command('load')
  .option('-m, --models', 'load models')
  .option('-s, --style', 'load style')
  .option('-t, --terms', 'load terms')
  .option('-b, --bot', 'load bot configuration')
  .option('-a, --all', 'load all configuration')
  .option('--dry-run', 'print but don\'t execute')
  .action(createAction('load'))

const validateCommand = program
  .command('validate')
  .option('-m, --models', 'validate models and lenses')
  .option('-s, --style', 'validate style')
  .option('-t, --terms', 'validate terms')
  .option('-b, --bot', 'validate bot configuration')
  .option('-a, --all', 'validate all configuration')
  .allowUnknownOption(false)
  .action(createAction('validate'))

const createDataBundleCommand = program
  .command('create-data-bundle')
  .option('-p, --path <path>', 'path to bundle to create')
  .allowUnknownOption(false)
  .action(createAction('createDataBundle'))

const createDataClaimCommand = program
  .command('create-data-claim')
  .option('-k, --key <key>', DESC.key)
  .allowUnknownOption(false)
  .action(createAction('createDataClaim'))

const getDataBundleCommand = program
  .command('get-data-bundle')
  .option('-c, --claimId <claimId>', 'claim id returned by create-data-claim command')
  .option('-k, --key <key>', DESC.key)
  .allowUnknownOption(false)
  .action(createAction('getDataBundle'))

const listDataClaimsCommand = program
  .command('list-data-claims')
  .option('-k, --key <key>', DESC.key)
  .allowUnknownOption(false)
  .action(createAction('listDataClaims'))

const initCommand = program
  .command('init')
  .allowUnknownOption(false)
  .action(createAction('init'))

const execCommand = program
  .command('exec <command>')
  .allowUnknownOption(false)
  .action(createAction('exec'))

const invokeCommand = program
  .command('invoke')
  .option('-f, --function-name <functionName>', 'invoke a lambda by name')
  .allowUnknownOption(false)
  .action(createAction('invoke'))

const destroyCommand = program
  .command('destroy')
  .allowUnknownOption(false)
  .action(createAction('destroy'))

// require AWS sdk after env variables are set
const AWS = require('aws-sdk')
const Conf = require('./')
// re-parse with env vars set

program.parse(process.argv)
// if (typeof parseResult.args[0] === 'string') {
if (!matchedCommand) {
  throw new Error(`command not found with name: ${process.argv[2]}`)
}
