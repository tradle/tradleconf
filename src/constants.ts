
import {
  KYCServicesConf,
  MapToKYCService,
} from './types'

export const TRADLE_ACCOUNT_ID = '210041114155'
export const SERVICES_STACK_TEMPLATE_URL = 'https://s3.eu-west-2.amazonaws.com/tradle.io/cf-templates/kyc-in-ecs/1.1.2/main.yml'
export const REPO_NAMES:KYCServicesConf = {
  truefaceSpoof: 'trueface-spoof',
  rankOne: 'rank-one',
  nginx: 'tradle-kyc-nginx-proxy',
}

export const BIG_BUCKETS = ['LogsBucket', 'ObjectsBucket']
export const SAFE_REMOTE_COMMANDS = ['log', 'tail', 'update', 'list-previous-versions', 'load']
export const REMOTE_ONLY_COMMANDS = ['log', 'tail', 'update', 'list-previous-versions']
export const IMMUTABLE_STACK_PARAMETERS = [
  'Stage',
  'BlockchainNetwork',
  'OrgName',
  'OrgDomain',
  'OrgLogo',
]

export const DOT = '·'

export const LICENSE_PATHS:KYCServicesConf = {
  truefaceSpoof: 'license/trueface-spoof/creds.json',
  rankOne: 'license/rankone/ROC.lic',
}

export const PARAM_TO_KYC_SERVICE_NAME:MapToKYCService = {
  EnableTruefaceSpoof: 'truefaceSpoof',
  EnableRankOne: 'rankOne',
}
