import AWS from 'aws-sdk'
import Errors from '@tradle/errors'
import {
  PointInTime,
  RestoreToPointInTimeOpts,
  FromTo,
} from './types'
import { Errors as CustomErrors } from './errors'

const isTTLEnabled = (ttl: AWS.DynamoDB.TimeToLiveDescription) => {
  return ttl.TimeToLiveStatus === 'ENABLING' || ttl.TimeToLiveStatus === 'ENABLED'
}

const canRetryAwaitExists = (err: AWS.AWSError) => {
  return /max attempts exceeded/i.test(err.message) || Errors.matches(err, { code: 'ResourceNotReady' })
}

class DynamoDB {
  constructor(private client: AWS.DynamoDB) {}
  public isPointInTimeRecoveryEnabled = async (tableName: string) => {
    const {
      ContinuousBackupsDescription
    } = await this.client.describeContinuousBackups({ TableName: tableName }).promise()

    return ContinuousBackupsDescription.ContinuousBackupsStatus === 'ENABLED'
  }

  public copyPointInTimeRecoverySettings = async ({ sourceName, destName }: FromTo) => {
    const enabled = await this.isPointInTimeRecoveryEnabled(sourceName)
    await this.setPointInTimeRecovery({ tableName: destName, enabled })
  }

  public setPointInTimeRecovery = async ({ tableName, enabled }: {
    tableName: string
    enabled: boolean
  }) => {
    await this.client.updateContinuousBackups({
      TableName: tableName,
      PointInTimeRecoverySpecification: {
        PointInTimeRecoveryEnabled: enabled
      }
    }).promise()
  }

  public ensureStreamMatchesTable = async ({ tableArn, streamArn }) => {
    const { Table } = await this.client.describeTable({ TableName: tableArn }).promise()
    if (Table.LatestStreamArn !== streamArn) {
      throw new CustomErrors.InvalidInput(`stream ${streamArn} does not match table ${tableArn}`)
    }
  }

  public assertCanRestoreTable = async ({ date, sourceName, destName }: RestoreToPointInTimeOpts) => {
    await Promise.all([
      this.assertTableExists(sourceName),
      this.assertTableDoesNotExist(destName),
      this.assertTableHasBackupForDate({ tableName: sourceName, date }),
    ])
  }

  public assertTableHasBackupForDate = async ({ tableName, date }: {
    tableName: string
    date: PointInTime
  }) => {
    const {
      ContinuousBackupsDescription,
    } = await this.client.describeContinuousBackups({ TableName: tableName }).promise()

    if (ContinuousBackupsDescription.ContinuousBackupsStatus !== 'ENABLED') {
      throw new CustomErrors.InvalidInput(`table ${tableName} does not have continuous backups enabled`)
    }

    const {
      EarliestRestorableDateTime,
      LatestRestorableDateTime,
    } = ContinuousBackupsDescription.PointInTimeRecoveryDescription

    const target = new Date(date)
    const min = new Date(EarliestRestorableDateTime)
    const max = new Date(LatestRestorableDateTime)
    if (target < min || target > max) {
      throw new CustomErrors.InvalidInput(`table ${tableName} can be restored only to a point within the following range: ${min.toISOString()} - ${max.toISOString()}`)
    }
  }

  public restoreTable = async ({ date, sourceName, destName }: RestoreToPointInTimeOpts) => {
    const params:AWS.DynamoDB.RestoreTableToPointInTimeInput = {
      RestoreDateTime: new Date(date),
      SourceTableName: sourceName,
      TargetTableName: destName,
    }

    await this.client.restoreTableToPointInTime(params).promise()
    await this.awaitExists(destName)
    await this.copyTableSettings({ sourceName, destName })
    const { Table } = await this.client.describeTable({ TableName: destName }).promise()
    return {
      table: Table.TableArn,
      stream: Table.LatestStreamArn,
    }
  }

  public awaitExists = async (tableName: string) => {
    try {
      await this.client.waitFor('tableExists', { TableName: tableName }).promise()
    } catch (err) {
      if (canRetryAwaitExists(err)) {
        // retry
        return this.awaitExists(tableName)
      }

      throw err
    }
  }

  public copyTableSettings = async ({ sourceName, destName }: {
    sourceName: string
    destName: string
  }) => {
    // do in series, just in case
    await this.copyPointInTimeRecoverySettings({ sourceName, destName })
    await this.copyTTLSettings({ sourceName, destName })
    await this.copyStreamSettings({ sourceName, destName })
  }

  public getTTLSettings = async (tableName: string):Promise<AWS.DynamoDB.TimeToLiveSpecification> => {
    const { TimeToLiveDescription } = await this.client.describeTimeToLive({ TableName: tableName }).promise()
    return {
      Enabled: isTTLEnabled(TimeToLiveDescription),
      AttributeName: TimeToLiveDescription.AttributeName
    }
  }

  public setTTLSettings = async ({ tableName, ttl }: {
    tableName: string
    ttl: AWS.DynamoDB.TimeToLiveSpecification
  }) => {
    const params:AWS.DynamoDB.UpdateTimeToLiveInput = {
      TableName: tableName,
      TimeToLiveSpecification: ttl
    }

    await this.client.updateTimeToLive(params).promise()
  }

  public copyTTLSettings = async ({ sourceName, destName }: FromTo) => {
    const ttl = await this.getTTLSettings(sourceName)
    if (ttl.Enabled) {
      await this.setTTLSettings({ tableName: destName, ttl })
    }
  }

  public getStreamSettings = async (tableName: string) => {
    const { Table } = await this.client.describeTable({ TableName: tableName }).promise()
    return Table.StreamSpecification
  }

  public setStreamSettings = async ({ tableName, settings }: {
    tableName: string
    settings: AWS.DynamoDB.StreamSpecification
  }) => {
    const params:AWS.DynamoDB.UpdateTableInput = {
      TableName: tableName,
      StreamSpecification: settings,
    }

    await this.client.updateTable(params).promise()
  }

  public copyStreamSettings = async ({ sourceName, destName }: FromTo) => {
    const settings = await this.getStreamSettings(sourceName)
    if (settings && settings.StreamEnabled) {
      await this.setStreamSettings({ tableName: destName, settings })
    }
  }

  public doesTableExist = async (tableName: string) => {
    try {
      await this.client.describeTable({ TableName: tableName }).promise()
    } catch (err) {
      Errors.ignore(err, { code: 'ResourceNotFoundException' })
      return false
    }

    return true
  }

  public assertTableExists = async (tableName: string, errMessage?: string) => {
    const exists = await this.doesTableExist(tableName)
    if (!exists) {
      throw new CustomErrors.InvalidInput(errMessage || `table does not exist: ${tableName}`)
    }
  }

  public assertTableDoesNotExist = async (tableName: string, errMessage?: string) => {
    const exists = await this.doesTableExist(tableName)
    if (exists) {
      throw new CustomErrors.InvalidInput(errMessage || `table already exists: ${tableName}`)
    }
  }
}

export const create = (client: AWS.DynamoDB) => new DynamoDB(client)
