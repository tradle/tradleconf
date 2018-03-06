import _ = require('lodash')
import chalk = require('chalk')

export interface IColors {
  error: string
  warn: string
  info: string
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
  info: 'white',
  success: 'green',
  question: 'whiteBright'
}

export const logger = <Logger>{}
export const colors = <Colorizer>{}

_.forEach(methodColors, (color, loggerMethod) => {
  logger[loggerMethod] = (...args) => console.log(chalk[color](...args))
  colors[loggerMethod] = (...args) => chalk[color](...args)
})
