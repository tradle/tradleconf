import { logger } from './logger'

export const emptyBucket = async (s3, Bucket) => {
  const deleteObjects = async (objects) => {
    // before we can delete the bucket, we must delete all versions of all objects
    const Objects = objects.map(({ Key, VersionId }) => ({ Key, VersionId }))

    await s3.deleteObjects({
      Bucket,
      Delete: { Objects }
    }).promise()
  }

  const run = async () => {
    let Versions
    try {
      // get the list of all objects in the bucket
      ({ Versions } = await s3.listObjectVersions({ Bucket }).promise())
    } catch (err) {
      if (err.code === 'NoSuchBucket') return

      throw err
    }

    let count = 0
    if (Versions.length > 0) {
      count += Versions.length
      // if the bucket contains objects, delete them
      logger.info(`Deleting ${Versions.length} object versions`)
      await deleteObjects(Versions)
    }

    // check for any files marked as deleted previously
    const { DeleteMarkers } = await s3.listObjectVersions({ Bucket }).promise()

    if (DeleteMarkers.length > 0) {
      count += DeleteMarkers.length
      // if the bucket contains delete markers, delete them
      logger.info(`Deleting ${DeleteMarkers.length} object delete markers`)
      await deleteObjects(DeleteMarkers)
    }

    // if there are any non-versioned contents, delete them too
    const { Contents } = await s3.listObjectsV2({ Bucket }).promise()

    if (Contents.length > 0) {
      count += Contents.length
      // if the bucket contains delete markers, delete them
      logger.info(`Deleting ${Contents.length} objects`)
      await deleteObjects(Contents)
    }

    return count
  }

  let count
  do {
    count = await run()
  } while (count)
}
