import nonNull from 'lodash/identity'
import inquirer from 'inquirer'
import Listr from 'listr'
import yn from 'yn'
import AWS from 'aws-sdk'
import { Conf, AWSClients, SetKYCServicesOpts } from './types'
import * as utils from './utils'
import { Errors as CustomErrors } from './errors'
import { logger, colors } from './logger'
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
const EIP_LIMIT = 5

interface UpdateKYCServicesOpts extends SetKYCServicesOpts {
  client: AWSClients
  mycloudStackName: string
  mycloudRegion: string
}

interface ConfigureKYCServicesOpts extends UpdateKYCServicesOpts {
  truefaceSpoof?: boolean
  rankOne?: boolean
}

export const getStackName = utils.getServicesStackName

export const getServicesStackId = async (cloudformation: AWS.CloudFormation, mycloudStackName: string) => {
  const servicesStackName = utils.getServicesStackName(mycloudStackName)
  return utils.getStackId(cloudformation, servicesStackName)
}

export const configureKYCServicesStack = async (conf: Conf, { truefaceSpoof, rankOne, client, mycloudStackName, mycloudRegion }: ConfigureKYCServicesOpts) => {
  const servicesStackName = getStackName(mycloudStackName)
  const servicesStackId = await getServicesStackId(client.cloudformation, mycloudStackName)
  const exists = !!servicesStackId
  const bucket = await conf.getPrivateConfBucket()
  const discoveryObjPath = `${bucket}/discovery/ecs-services.json`
  if (typeof truefaceSpoof === 'boolean' && typeof rankOne === 'boolean') {
    // user knows what they want
  } else {
    const tfVerb = truefaceSpoof ? 'enable' : 'disable'
    const roVerb = rankOne ? 'enable' : 'disable'
    await confirmOrAbort(`${tfVerb} TrueFace Spoof, ${roVerb} RankOne?`)
  }

  const repoNames = [
    REPO_NAMES.nginx,
    truefaceSpoof && REPO_NAMES.truefaceSpoof,
    rankOne && REPO_NAMES.rankOne,
  ].filter(nonNull).join(', ')

  await confirmOrAbort(`has Tradle given you access to the following ECR repositories? ${repoNames}`)
  const region = mycloudRegion
  const azsCount = AZS_COUNT
  const availabilityZones = exists
    ? (await getServicesStackInfo(client, { stackId: servicesStackId })).availabilityZones
    : await chooseAZs(client, { region, count: azsCount })

  const usedEIPCount = await utils.getUsedEIPCount(client.ec2)
  if (!exists && EIP_LIMIT - usedEIPCount < azsCount) {
    await confirmOrAbort(`WARNING: your account has ${usedEIPCount} Elastic IPs in use in region ${region}.
This stack will create ${azsCount} more. AWS's base limit is 5 per region, so this stack may fail.
You can request a limit increase from AWS here: https://console.aws.amazon.com/support/v1#/case/create?issueType=service-limit-increase&limitType=service-code-vpc
Continue?`)
  }

  const willDeleteStack = !(truefaceSpoof || rankOne)
  if (willDeleteStack) {
    await confirmOrAbort(`you've disabled all the services disabled, can I delete the KYC services stack?`)
    logger.info('deleting KYC services stack: ${servicesStackId}, ETA: 5-10 minutes')
    await utils.deleteStackAndWait({
      cloudformation: client.cloudformation,
      params: {
        StackName: servicesStackId
      },
    })

    return
  }

  // change regions
  // if (region !== mycloudRegion) {
  //   client = conf.createAWSClient({ region })
  // }

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
    const key = await chooseEC2KeyPair(client.ec2)
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
        let waitMethod
        if (exists) {
          method = 'updateStackInRegion'
          waitMethod = 'awaitStackUpdate'
        } else {
          method = 'createStackInRegion'
          waitMethod = 'awaitStackCreate'
          // @ts-ignore
          params.DisableRollback = true
        }

        ctx.wait = await utils[method]({ params, region })
      },
    },
    {
      title: exists
        ? `update KYC services stack`
        : `create KYC services stack (this will take ~20 minutes)`,
      task: ctx => ctx.wait(),
    },
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

// const chooseRegionAndAZs = async (client: AWSClients, { count, defaultRegion }: {
//   count: number
//   defaultRegion: string
// }) => {
//   let region
//   if (defaultRegion) {
//     const useSameRegion = await confirm('deploy in the same region as MyCloud?')
//     if (useSameRegion) region = defaultRegion
//   }

//   if (!region) {
//     region = await chooseRegion({ default: defaultRegion })
//   }

//   // const usedEIPCount = await utils.getUsedEIPCount(client)
//   // if (usedEIPCount > 2) {
//   //   await confirmOrAbort(`your account has ${usedEIPCount} elastic ips in use. This stack will create ${count} more. Keep in mind that AWS's base limit is 5 per account. You can easily get them to relax that limit, but if you haven't yet, there's a chance this stack will fail.`)
//   // }

//   const availabilityZones = await chooseAZs(client, { region, count })
//   return {
//     region,
//     availabilityZones,
//   }
// }

export const deleteCorrespondingServicesStack = async ({ cloudformation, stackId }: {
  cloudformation: AWS.CloudFormation
  stackId: string
}) => {
  const { stackName } = utils.parseStackArn(stackId)
  const servicesStackId = await getServicesStackId(cloudformation, stackName)
  if (!servicesStackId) {
    throw new CustomErrors.NotFound(`services stack for mycloud stack: ${stackId}`)
  }

  logger.info(`KYC services stack: deleting ${servicesStackId}, ETA: 5-10 minutes`)
  await utils.deleteStackAndWait({
    cloudformation,
    params: {
      StackName: servicesStackId
    },
  })

  logger.info(`KYC services stack: deleted ${servicesStackId}`)
}

export const updateKYCServicesStack = async (conf: Conf, { client, mycloudStackName, mycloudRegion }: UpdateKYCServicesOpts) => {
  const { cloudformation } = client
  const servicesStackName = getStackName(mycloudStackName)
  const servicesStackId = await getServicesStackId(cloudformation, mycloudStackName)
  if (!servicesStackId) {
    throw new CustomErrors.NotFound(`existing kyc-services stack not found`)
  }

  let parameters = await utils.getStackParameters({ cloudformation, stackId: servicesStackId })
  parameters = parameters
    .filter(p => !p.ParameterKey.endsWith('Image')) // template will have new Image defaults
    .map(p => ({
      ParameterKey: p.ParameterKey,
      UsePreviousValue: true,
    }))

  await confirmOrAbort(`About to update KYC services stack. Are you freaking ready?`)
  const tasks = [
    {
      title: 'validate template',
      task: async (ctx) => {
        const params: AWS.CloudFormation.UpdateStackInput = {
          StackName: servicesStackId || servicesStackName,
          TemplateURL: SERVICES_STACK_TEMPLATE_URL,
          Parameters: parameters,
          Capabilities: ['CAPABILITY_NAMED_IAM']
        }

        ctx.wait = await utils.updateStack({ cloudformation, params })
      },
    },
    {
      title: `update KYC services stack`,
      task: ctx => ctx.wait(),
    },
    {
      title: 'poke MyCloud to pick up update',
      task: async () => {
        await conf.reboot()
      }
    },
  ]

  await new Listr(tasks).run()
}
