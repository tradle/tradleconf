import AWS from 'aws-sdk'
import { Conf } from './'

export { Conf }

export { Logger } from './logger'

export type AWSClients = {
  s3: AWS.S3
  dynamodb: AWS.DynamoDB
  // iot: AWS.Iot
  // iotData: AWS.IotData
  // sts: AWS.STS
  // sns: AWS.SNS
  // ses: AWS.SES
  // kms: AWS.KMS
  // docClient: AWS.DynamoDB.DocumentClient
  logs: AWS.CloudWatchLogs
  lambda: AWS.Lambda
  cloudformation: AWS.CloudFormation
  // xray: AWS.XRay
  // apigateway: AWS.APIGateway
  // autoscaling: AWS.AutoScaling
  // applicationAutoScaling: AWS.ApplicationAutoScaling
  ecr: AWS.ECR
  ec2: AWS.EC2
  opsworks: AWS.OpsWorks
  kms: AWS.KMS
  // AWS: any
  // trace: any
  region: string
}

export type NodeFlags = {
  inspect?: boolean
  ['inspect-brk']?: boolean
  debug?: boolean
  ['debug-brk']?: boolean
}

export type ConfOpts = {
  // client: AWSClients
  region?: string
  profile?: string
  stackName?: string
  stackId?: string
  namespace?: string
  local?: boolean
  remote?: boolean
  project?: string
  nodeFlags?: NodeFlags
}

export interface UpdateOpts {
  stackName: string
  tag: string
  provider?: string
  showReleaseCandidates?: boolean
  force?: boolean
  rollback?: boolean
}

export interface VersionInfo {
  tag: string
  sortableTag: string
  templateUrl?: string
}

export type InvokeOpts = {
  functionName: string
  arg?: any
  noWarning?: boolean
}

export type WaitStackOpts = {
  stackName: string
}

export interface GetUpdateInfoResp {
  update: VersionInfo
  upToDate: boolean
}

export interface ApplyUpdateOpts {
  templateUrl: string
  notificationTopics?: string[]
}

export interface Choice {
  name: string
  value: string
}

export interface SetKYCServicesOpts {
  truefaceSpoof?: boolean
  rankOne?: boolean
}

export type PointInTime = string

export type CloudResourceType = 'bucket'|'table'|'key'|'loggroup'
export interface CloudResource {
  type: CloudResourceType
  name: string
  value: string
}

export type CFParameter = AWS.CloudFormation.Parameter

export interface CFParameterDef {
  Type: AWS.CloudFormation.ParameterType
  Default?: AWS.CloudFormation.ParameterValue
  Description?: string
  AllowedValues?: AWS.CloudFormation.ParameterValue[]
  AllowedPattern?: string
  ConstraintDescription?: string
  MinLength?: number
  MaxLength?: number
  MinValue?: number
  MaxValue?: number
  // added by tradleconf
  Name?: AWS.CloudFormation.ParameterKey
  Label?: string
}

export interface CFParameterDefMap {
  [name: string]: CFParameterDef
}

export interface CFResource {
  Type: string
  Properties: any
  Description?: string
  DeletionPolicy?: string
}

export interface CFTemplate {
  Parameters: CFParameterDefMap
  Mappings: any
  Resources: CFResource
}

export interface ClientOpts {
  region?: string
  profile?: string
}

export interface FromToTable {
  sourceName: string
  destName: string
}

export interface RestoreTableOpts extends FromToTable {
  date: PointInTime
}

export interface RestoreTableCliOpts extends RestoreTableOpts, ClientOpts {
}
