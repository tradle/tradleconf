import { Conf } from './'

export { Conf }

export type AWSClients = {
  s3: AWS.S3,
  dynamodb: AWS.DynamoDB,
  iot: AWS.Iot,
  iotData: AWS.IotData,
  sts: AWS.STS,
  sns: AWS.SNS,
  ses: AWS.SES,
  kms: AWS.KMS,
  docClient: AWS.DynamoDB.DocumentClient,
  lambda: AWS.Lambda,
  cloudformation: AWS.CloudFormation,
  xray: AWS.XRay,
  apigateway: AWS.APIGateway,
  AWS: any,
  trace: any
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
  local?: boolean
  remote?: boolean
  project?: string
  nodeFlags?: NodeFlags
}
