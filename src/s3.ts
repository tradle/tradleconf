
import AWS from 'aws-sdk'
import execa from 'execa'
import Errors from '@tradle/errors'
import { Errors as CustomErrors } from './errors'
import { validateISODate } from './utils'
import {
  FromTo,
  RestoreBucketOpts,
} from './types'

const assertS3RestoreToolInstalled = () => {
  try {
    execa.sync('command', ['-v', 's3-pit-restore'])
  } catch (err) {
    throw new CustomErrors.NotFound(`please install the s3-pit-restore tool first. Here's how:

git clone https://github.com/tradle/s3-pit-restore
cd s3-pit-restore
python3 setup.py install
`)
  }
}

class S3 {
  constructor(private client: AWS.S3) {}
  public static validateBucketName = (name: string) => {
    if (name.length < 3 || name.length > 63) {
      throw new CustomErrors.InvalidInput(`bucket name must be between 3 and 63 characters long: ${name}`)
    }
  }

  public createBucket = async (bucket: string) => {
    S3.validateBucketName(bucket)
    try {
      await this.client.createBucket({ Bucket: bucket }).promise()
    } catch (err) {
      if (Errors.matches(err, { code: 'InvalidBucketName' })) {
        throw new CustomErrors.InvalidInput(`invalid bucket name: ${bucket}`)
      }

      throw err
    }
  }

  public getBucketEncryption = async (bucket: string) => {
    try {
      const { ServerSideEncryptionConfiguration } = await this.client.getBucketEncryption({ Bucket: bucket }).promise()
      return ServerSideEncryptionConfiguration
    } catch (err) {
      Errors.ignore(err, { code: 'ServerSideEncryptionConfigurationNotFoundError' })
      throw new CustomErrors.NotFound(`encryption configuration for bucket: ${bucket}`)
    }
  }

  public setBucketEncryption = async ({ bucket, encryption }: {
    bucket: string
    encryption: AWS.S3.ServerSideEncryptionConfiguration
  }) => {
    await this.client.putBucketEncryption({
      Bucket: bucket,
      ServerSideEncryptionConfiguration: encryption,
    }).promise()
  }

  public getBucketVersioning = async (bucket: string) => {
    const { Status, MFADelete } = await this.client.getBucketVersioning({ Bucket: bucket }).promise()
    return { Status, MFADelete }
  }

  public setBucketVersioning = async ({ bucket, versioning }: {
    bucket: string
    versioning: AWS.S3.VersioningConfiguration
  }) => {
    await this.client.putBucketVersioning({
      Bucket: bucket,
      VersioningConfiguration: versioning
    }).promise()
  }

  public getBucketLifecycle = async (bucket: string):Promise<AWS.S3.BucketLifecycleConfiguration> => {
    try {
      const { Rules = [] } = await this.client.getBucketLifecycleConfiguration({ Bucket: bucket }).promise()
      return { Rules }
    } catch (err) {
      Errors.ignore(err, { code: 'NoSuchLifecycleConfiguration' })
      throw new CustomErrors.NotFound(`lifecycle configuration for bucket: ${bucket}`)
    }
  }

  public setBucketLifecycle = async ({ bucket, lifecycle }: {
    bucket: string
    lifecycle: AWS.S3.BucketLifecycleConfiguration
  }) => {
    const params:AWS.S3.PutBucketLifecycleConfigurationRequest = {
      Bucket: bucket,
      LifecycleConfiguration: lifecycle,
    }

    await this.client.putBucketLifecycleConfiguration(params).promise()
  }

  public getBucketCORS = async (bucket: string):Promise<AWS.S3.CORSConfiguration> => {
    try {
      const { CORSRules = [] } = await this.client.getBucketCors({ Bucket: bucket }).promise()
      return { CORSRules }
    } catch (err) {
      Errors.ignore(err, { code: 'NoSuchCORSConfiguration' })
      throw new CustomErrors.NotFound(`CORS configuration for bucket: ${bucket}`)
    }
  }

  public setBucketCORS = async ({ bucket, cors }: {
    bucket: string
    cors: AWS.S3.CORSConfiguration
  }) => {
    const params:AWS.S3.PutBucketCorsRequest = {
      Bucket: bucket,
      CORSConfiguration: cors,
    }

    await this.client.putBucketCors(params).promise()
  }

  public copyBucketSettings = async ({ sourceName, destName }: FromTo) => {
    // in series on purpose
    // s3 doesn't like running some of these in parallel
    await this.copyBucketEncryption({ sourceName, destName })
    await this.copyBucketVersioning({ sourceName, destName })
    await this.copyBucketLifecycle({ sourceName, destName })
    await this.copyBucketCORS({ sourceName, destName })
  }

  public copyBucketEncryption = async ({ sourceName, destName }: FromTo) => {
    let encryption
    try {
      encryption = await this.getBucketEncryption(sourceName)
    } catch (err) {
      Errors.ignore(err, CustomErrors.NotFound)
      return
    }

    await this.setBucketEncryption({ bucket: destName, encryption })
  }

  public copyBucketVersioning = async ({ sourceName, destName }: FromTo) => {
    const versioning = await this.getBucketVersioning(sourceName)
    if (versioning.Status) {
      await this.setBucketVersioning({ bucket: destName, versioning })
    }
  }

  public copyBucketLifecycle = async ({ sourceName, destName }: FromTo) => {
    let lifecycle
    try {
      lifecycle = await this.getBucketLifecycle(sourceName)
    } catch (err) {
      Errors.ignore(err, CustomErrors.NotFound)
      return
    }

    await this.setBucketLifecycle({ bucket: destName, lifecycle })
  }

  public copyBucketCORS = async ({ sourceName, destName }: FromTo) => {
    let cors
    try {
      cors = await this.getBucketCORS(sourceName)
    } catch (err) {
      Errors.ignore(err, CustomErrors.NotFound)
      return
    }

    await this.setBucketCORS({ bucket: destName, cors })
  }

  public assertBucketIsEmptyOrDoesNotExist = async (bucket: string) => {
    const exists = await this.doesBucketExist(bucket)
    if (exists) {
      await this.assertBucketIsEmpty(bucket)
    } else {
      await this.createBucket(bucket)
    }
  }

  public assertBucketIsEmpty = async (bucket: string) => {
    const isEmpty = await this.isBucketEmpty(bucket)
    if (!isEmpty) {
      throw new CustomErrors.InvalidInput(`expected bucket to be empty: ${bucket}`)
    }
  }

  public assertBucketExists = async (bucket: string) => {
    const exists = await this.doesBucketExist(bucket)
    if (!exists) {
      throw new CustomErrors.InvalidInput(`bucket does not exist: ${bucket}`)
    }
  }

  public doesBucketExist = async (bucket: string) => {
    try {
      await this.client.headBucket({ Bucket: bucket }).promise()
    } catch (err) {
      Errors.ignore(err, { code: 'NotFound' })
      return false
    }

    return true
  }

  public isBucketEmpty = async (bucket: string) => {
    const { Contents } = await this.client.listObjectsV2({ Bucket: bucket, MaxKeys: 1 }).promise()
    return Contents.length === 0
  }

  public assertCanRestoreBucket = async (opts: RestoreBucketOpts) => {
    const { sourceName, destName, date } = opts
    assertS3RestoreToolInstalled()
    validateISODate(date)
    const exists = await this.doesBucketExist(destName)
    if (exists) {
      await this.assertBucketIsEmpty(destName)
    }
  }

  public createIfNotExists = async (bucket: string) => {
    if (!(await this.doesBucketExist(bucket))) {
      await this.createBucket(bucket)
    }
  }

  public restoreBucket = async ({ sourceName, destName, date, profile }: RestoreBucketOpts) => {
    await this.createIfNotExists(destName)
    await this.copyBucketSettings({ sourceName, destName })

    const env:any = {}
    if (profile) env.AWS_PROFILE = profile

    await execa('s3-pit-restore', ['-b', sourceName, '-d', `s3://${destName}`, '-t', date], { env })
  }
}

export const create = (client: AWS.S3) => new S3(client)
