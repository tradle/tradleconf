import AWS from 'aws-sdk'
import {
  PointInTime
} from './types'

interface FromToTable {
  sourceName: string
  targetName: string
}

interface RestoreTableOpts extends FromToTable {
  region: string
  pointInTime: PointInTime
}

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

  public restoreTable = async ({ region, pointInTime, sourceName, targetName }: RestoreTableOpts) => {
    const params:AWS.DynamoDB.RestoreTableToPointInTimeInput = {
      RestoreDateTime: new Date(pointInTime),
      SourceTableName: sourceName,
      TargetTableName: targetName,
    }

    await this.client.restoreTableToPointInTime(params).promise()
    await this.copyTableSettings({ region, sourceName, targetName })
  }

  public copyTableSettings = async ({ region, sourceName, targetName }: {
    region: string
    sourceName: string
    targetName: string
  }) => {
    const enablePointInTimeRecovery = this.setPointInTimeRecovery({
      tableName: targetName,
      enabled: true
    })

    const copyTTL = this.copyTTLSettings({ sourceName, targetName })
    const copyStreamSettings = this.copyStreamSettings({ sourceName, targetName })
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

  public copyTTLSettings = async ({ sourceName, targetName }: FromToTable) => {
    const ttl = await this.getTTLSettings(sourceName)
    await this.setTTLSettings({ tableName: targetName, ttl })
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

  public copyStreamSettings = async ({ sourceName, targetName }: FromToTable) => {
    const settings = await this.getStreamSettings(sourceName)
    await this.setStreamSettings({ tableName: targetName, settings })
  }
}

export const create = (client: AWS.DynamoDB) => new DynamoDB(client)
