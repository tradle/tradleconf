import _ = require('lodash')
import chalk = require('chalk')

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
  warn: string
  info: string
  debug: string
  // misc
  success: string
  question: string
}

export type Colorizer = {
  [color in keyof IColors]: Function
}

export type Logger = {
  [key in keyof IColors]: Function
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

_.forEach(methodColors, (color, loggerMethod) => {
  logger[loggerMethod] = (...args) => {
    if (level >= levels[loggerMethod]) {
      console.log(chalk[color](...args))
    }
  }

  colors[loggerMethod] = (...args) => chalk[color](...args)
})
