import AWS from 'aws-sdk'
import { PointInTime, RestoreTableOpts, FromToTable } from './types'
import { Errors as CustomErrors } from './errors'

const isTTLEnabled = (ttl: AWS.DynamoDB.TimeToLiveDescription) => {
  return ttl.TimeToLiveStatus === 'ENABLING' || ttl.TimeToLiveStatus === 'ENABLED'
}

class DynamoDB {
  constructor(private client: AWS.DynamoDB) {}
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

  public restoreTable = async ({ date, sourceName, destName }: RestoreTableOpts) => {
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
      if (/max attempts exceeded/i.test(err.message)) {
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
    const enablePointInTimeRecovery = this.setPointInTimeRecovery({
      tableName: destName,
      enabled: true
    })

    const copyTTL = this.copyTTLSettings({ sourceName, destName })
    const copyStreamSettings = this.copyStreamSettings({ sourceName, destName })
    await Promise.all([
      enablePointInTimeRecovery,
      copyTTL,
      copyStreamSettings,
    ])
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

  public copyTTLSettings = async ({ sourceName, destName }: FromToTable) => {
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

  public copyStreamSettings = async ({ sourceName, destName }: FromToTable) => {
    const settings = await this.getStreamSettings(sourceName)
    await this.setStreamSettings({ tableName: destName, settings })
  }
}

export const create = (client: AWS.DynamoDB) => new DynamoDB(client)
