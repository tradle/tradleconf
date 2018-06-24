
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
