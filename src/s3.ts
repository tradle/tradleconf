
import AWS from 'aws-sdk'
import execa from 'execa'
import Errors from '@tradle/errors'
import { Errors as CustomErrors } from './errors'
import { validateISODate } from './utils'

const assertS3RestoreToolInstalled = () => {
  try {
    execa.sync('command', ['-v', 's3-pit-restore'])
  } catch (err) {
    throw new CustomErrors.NotFound(`please install this tool first: https://github.com/madisoft/s3-pit-restore`)
  }
}

type FromToBucket = {
  source: string
  target: string
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

  public copyBucketSettings = async ({ source, target }: FromToBucket) => {
    // in series on purpose
    // s3 doesn't like running some of these in parallel
    await this.copyBucketEncryption({ source, target })
    await this.copyBucketVersioning({ source, target })
    await this.copyBucketLifecycle({ source, target })
    await this.copyBucketCORS({ source, target })
  }

  public copyBucketEncryption = async ({ source, target }: FromToBucket) => {
    let encryption
    try {
      encryption = await this.getBucketEncryption(source)
    } catch (err) {
      Errors.ignore(err, CustomErrors.NotFound)
      return
    }

    await this.setBucketEncryption({ bucket: target, encryption })
  }

  public copyBucketVersioning = async ({ source, target }: FromToBucket) => {
    const versioning = await this.getBucketVersioning(source)
    if (versioning.Status) {
      await this.setBucketVersioning({ bucket: target, versioning })
    }
  }

  public copyBucketLifecycle = async ({ source, target }: FromToBucket) => {
    let lifecycle
    try {
      lifecycle = await this.getBucketLifecycle(source)
    } catch (err) {
      Errors.ignore(err, CustomErrors.NotFound)
      return
    }

    await this.setBucketLifecycle({ bucket: target, lifecycle })
  }

  public copyBucketCORS = async ({ source, target }: FromToBucket) => {
    let cors
    try {
      cors = await this.getBucketCORS(source)
    } catch (err) {
      Errors.ignore(err, CustomErrors.NotFound)
      return
    }

    await this.setBucketCORS({ bucket: target, cors })
  }

  public createBucketOrAssertEmpty = async (bucket: string) => {
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

  public restoreBucket = async ({ source, dest, date, profile }: {
    source: string
    dest: string
    date: string
    profile?: string
  }) => {
    assertS3RestoreToolInstalled()
    validateISODate(date)

    const env:any = {}
    if (profile) env.AWS_PROFILE = profile

    const destDir = `restore/${dest}`
    await execa('s3-pit-restore', ['-b', source, '-d', destDir, '-t', date], { env })
    await execa('aws', ['s3', 'sync', destDir, `s3://${dest}`], { env })
    await execa('rm', ['-rf', destDir])
  }
}

export const create = (client: AWS.S3) => new S3(client)
