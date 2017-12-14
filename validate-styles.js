const validateResource = require('@tradle/validate-resource')
const { models } = require('@tradle/models')

validateResource({
  models,
  resource: require('./styles')
})
