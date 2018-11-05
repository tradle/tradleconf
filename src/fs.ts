import fs from 'fs'
import path from 'path'
import promisify from 'pify'

const pfs = promisify(fs)
const prettify = obj => {
  return typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2)
}

export const read:any = file => fs.readFileSync(file, { encoding: 'utf8' })
export const maybeRead = file => {
  if (exists(file)) return read(file)
}

export const readJSON = file => JSON.parse(read(file))
export const maybeReadJSON = file => {
  const result = maybeRead(file)
  if (result) return JSON.parse(result)
}

export const write = (file, data) => fs.writeFileSync(file, prettify(data))
export const pwrite = (file, data) => pfs.writeFile(file, prettify(data))
export const exists = file => fs.existsSync(file)
export const readDirOfJSONs = dir => fs.readdirSync(dir)
  .filter(file => file.endsWith('.json'))
  .map(file => require(path.resolve(dir, file)))
