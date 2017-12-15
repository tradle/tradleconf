
const path = require('path')
const fs = require('fs')
const validateResource = require('@tradle/validate-resource')
const { models } = require('@tradle/models')
const file = path.resolve(process.argv[2])
const conf = require(file)
const { tours } = conf
if (tours) {
  const model = models['tradle.Tour']
  for (let name in tours) {
    validateResource({
      models,
      model,
      resource: tours[name]
    })
  }
}
