const fs = require('fs')
const path = require('path')
const marked = require('marked')
const file = path.resolve(process.argv[2])
if (fs.existsSync(file)) {
  const content = fs.readFileSync(file, { encoding: 'utf8' })

  try {
    marked(content)
  } catch (err) {
    console.error('invalid markdown!', err.stack) // eslint-disable-line no-console
    process.exitCode = 1
  }
}
