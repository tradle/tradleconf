import nonNull from 'lodash/identity'
import inquirer from 'inquirer'
import Listr from 'listr'
import yn from 'yn'
import { Conf, AWSClients } from './types'
import * as utils from './utils'
import {
  confirm,
  confirmOrAbort,
  chooseEC2KeyPair,
  chooseRegion,
  chooseAZs,
} from './prompts'

import {
  SERVICES_STACK_TEMPLATE_URL,
  REPO_NAMES,
} from './constants'

const AZS_COUNT = 3

export const configureKYCServicesStack = async (conf: Conf, { truefaceSpoof, rankOne, client, mycloudStackName }: {
  truefaceSpoof: boolean
  rankOne: boolean
  client: AWSClients
  mycloudStackName: string
}) => {
  const servicesStackName = utils.getServicesStackName(mycloudStackName)
  const servicesStackId = await utils.getStackId(client, servicesStackName)
  const exists = !!servicesStackId
  const bucket = await conf.getPrivateConfBucket()
  const discoveryObjPath = `${bucket}/discovery/ecs-services.json`
  const tfVerb = truefaceSpoof ? 'enable' : 'disable'
  const roVerb = rankOne ? 'enable' : 'disable'
  await confirmOrAbort(`${tfVerb} TrueFace Spoof, ${roVerb} RankOne?`)
  const repoNames = [
    REPO_NAMES.nginx,
    truefaceSpoof && REPO_NAMES.truefaceSpoof,
    rankOne && REPO_NAMES.rankOne,
  ].filter(nonNull).join(', ')

  await confirmOrAbort(`has Tradle given you access to the following ECR repositories? ${repoNames}`)
  const azsCount = AZS_COUNT
  const { region, availabilityZones } = exists
    ? await getServicesStackInfo(client, { stackId: servicesStackId })
    : await chooseRegionAndAZs(client, { count: azsCount })

  const enableSSH = yn(await confirm('enable SSH into the instances?', false))
  const parameters = availabilityZones.map((az, i) => ({
    ParameterKey: `AZ${(i + 1)}`,
    ParameterValue: az
  }))

  parameters.push({
    ParameterKey: 'S3PathToWriteDiscovery',
    ParameterValue: discoveryObjPath
  })

  if (truefaceSpoof) {
    parameters.push({
      ParameterKey: 'EnableTruefaceSpoof',
      ParameterValue: 'true'
    })
  }

  if (rankOne) {
    parameters.push({
      ParameterKey: 'EnableRankOne',
      ParameterValue: 'true',
    })
  }

  if (enableSSH) {
    const key = await chooseEC2KeyPair(client)
    parameters.push({
      ParameterKey: 'KeyName',
      ParameterValue: key
    })
  }

  await confirmOrAbort(`are you freaking ready?`)
  const tasks = [
    {
      title: 'validate template',
      task: async (ctx) => {
        const params: AWS.CloudFormation.UpdateStackInput = {
          StackName: servicesStackId || servicesStackName,
          Parameters: parameters,
          TemplateURL: SERVICES_STACK_TEMPLATE_URL,
          Capabilities: ['CAPABILITY_NAMED_IAM']
        }

        let method
        if (exists) {
          method = 'updateStack'
        } else {
          method = 'createStack'
          // @ts-ignore
          params.DisableRollback = true
        }

        ctx.wait = await utils[method](client, params)
      },
    },
    {
      title: `create/update KYC services stack`,
      task: ctx => ctx.wait(),
    }
  ]

  await new Listr(tasks).run()
}

const getServicesStackInfo = async (client: AWSClients, { stackId }: {
  stackId: string
}) => {
  const { Stacks } = await client.cloudformation.describeStacks({
    StackName: stackId,
  }).promise()

  const { Outputs } = Stacks[0]
  const availabilityZones = (getOutput(Outputs, 'AvailabilityZones') as string).split(',')
  const region = getOutput(Outputs, 'Region') as string
  return {
    region,
    availabilityZones,
  }
}

const getOutput = (Outputs: AWS.CloudFormation.Output[], key: string) => Outputs.find(o => o.OutputKey === key).OutputValue

const chooseRegionAndAZs = async (client: AWSClients, { count }) => {
  const usedEIPCount = await utils.getUsedEIPCount(client)
  if (usedEIPCount > 2) {
    await confirmOrAbort(`your account has ${usedEIPCount} elastic ips in use. This stack will create ${count} more. Keep in mind that AWS's base limit is 5 per account. You can easily get them to relax that limit, but if you haven't yet, there's a chance this stack will fail.`)
  }

  const region = await chooseRegion()
  const availabilityZones = await chooseAZs(client, { region, count })
  return {
    region,
    availabilityZones,
  }
}
