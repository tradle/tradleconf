import forEach from 'lodash/forEach'
import chalk from 'ansi-colors'

let level = 4
const levels = {
  // levels
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  // these are logged always
  success: -Infinity,
  question: -Infinity,
}

export interface IColors {
  error: string
  errorBold: string
  warn: string
  warnBold: string
  info: string
  infoBold: string
  debug: string
  debugBold: string
  // misc
  success: string
  successBold: string
  question: string
  questionBol: string
}

export type Colorizer = {
  [color in keyof IColors]: (str: string) => string
}

export type Logger = {
  [key in keyof IColors]: (str: string) => void
}

const methodColors = {
  error: 'red',
  warn: 'yellow',
  info: 'grey',
  success: 'green',
  question: 'cyan',
  debug: 'magenta'
}

export const logger = <Logger>{}
export const colors = <Colorizer>{}
export const setLevel = value => {
  level = value
}

forEach(methodColors, (color, loggerMethod) => {
  logger[loggerMethod] = (str) => {
    if (level >= levels[loggerMethod]) {
      // send to stderr
      // reserve stdout for command output
      console.error(chalk[color](str))
    }
  }

  logger[loggerMethod + 'Bold'] = (str) => logger[loggerMethod](chalk.bold(str))
  colors[loggerMethod] = (...args) => chalk[color](...args)
})

// for choosing
export const printColors = () => {
  Object.getOwnPropertyNames(chalk)
    .filter(key => typeof chalk[key] === 'function')
    .map(color => {
      try {
        return chalk[color](color)
      } catch (err) {}
    })
    .filter(val => typeof val === 'string')
    .forEach(str => console.log(str))
}
