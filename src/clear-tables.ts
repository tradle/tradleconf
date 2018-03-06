import yn = require('yn')
import readline = require('readline')
import AWS = require('aws-sdk')
import { Conf } from './types'

const skip = [
  'pubkeys',
  'presence',
  'events',
  'seals',
  'tradle_MyCloudFriend'
]

// export const mixinTableMethods = (conf: Conf) => ({
//   listTables: async () => {
//     let tables:string[] = []
//     let opts:AWS.DynamoDB.ListTablesInput = {}
//     while (true) {
//       let {
//         TableNames,
//         LastEvaluatedTableName
//       } = await conf.client.dynamodb.listTables(opts).promise()

//       tables = tables.concat(TableNames)
//       if (!TableNames.length || !LastEvaluatedTableName) {
//         break
//       }

//       opts.ExclusiveStartTableName = LastEvaluatedTableName
//     }

//     return tables.filter(name => name.startsWith(conf.stackName))
//   },

//   getTablesToClear: async (tables:string[]=[]) => {
//     if (tables.length) {
//       tables = tables.map(name => {
//         return name.startsWith() ? name : env.SERVERLESS_PREFIX + name
//       })
//     } else {
//       tables = await listTables(env)
//       tables = tables.filter(name => {
//         return !skip.find(skippable => env.SERVERLESS_PREFIX + skippable === name)
//       })
//     }

//     console.log(`will empty the following tables at endpoint ${href}\n`, tables)
//     const rl = readline.createInterface(process.stdin, process.stdout)
//     const answer = await new Promise(resolve => {
//       rl.question('continue? y/[n]:', resolve)
//     })

//     rl.close()
//     if (!yn(answer)) {
//       console.log('aborted')
//       return
//     }

//     return tables
//   },

//   clearTables: async () => {
//     const { href } = this.client.dynamodb.endpoint
//     const tables = await conf.getTablesToClear()
//     if (!(tables && tables.length)) return

//     console.log(`will empty the following tables at endpoint ${href}\n`, tables)
//     console.log('let the games begin!')
//     for (const table of tables) {
//       console.log('clearing', table)
//       const numDeleted = await clear(table)
//       console.log(`deleted ${numDeleted} items from ${table}`)
//     }

//     console.log('done!')
//   }
// })
