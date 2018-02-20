const _ = require('lodash')
const chalk = require('chalk')
const colors = {
  error: 'red',
  warn: 'yellow',
  info: 'white',
  success: 'green',
  question: 'whiteBright'
}

const logger = {
  color: {}
}

_.forEach(colors, (color, loggerMethod) => {
  logger[loggerMethod] = (...args) => console.log(chalk[color](...args))
  logger.color[loggerMethod] = (...args) => chalk[color](...args)
})

module.exports = logger
