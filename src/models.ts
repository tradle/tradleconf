export const models = {
  ...require('@tradle/models').models,
  ...require('@tradle/custom-models'),
  ...require('@tradle/models-cloud').models
}
