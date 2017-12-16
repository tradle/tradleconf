const path = require('path')
const validateResource = require('@tradle/validate-resource')
const { models } = require('@tradle/models')
const file = path.resolve(process.argv[2])
const resource = require(file)

validateResource({ models, resource })
