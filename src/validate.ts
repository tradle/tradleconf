import _ = require('lodash')
import builtInModels = require('./models')
import mergeModels = require('@tradle/merge-models')
import ModelsPack = require('@tradle/models-pack')
import * as utils from './utils'

export const modelsPack = ({ namespace, models, lenses }) => {
  // validate model set
  mergeModels()
    .add(builtInModels, { validate: false })
    .add(models)

  // validate pack
  utils.pack({ namespace, models, lenses })
}

export const bot = conf => {
  const { tours } = conf
  if (tours) {
    _.each(tours, tour => utils.validateResource(tour))
  }
}

export const style = style => utils.validateResource(style)

export const terms = terms => {
  if (!terms.length) {
    throw new Error('terms and conditions cannot be empty')
  }

  const marked = require('marked')
  try {
    marked(terms)
  } catch (err) {
    throw new Error(`expected terms and conditions to be valid markdown: ${err.message}`)
  }
}
