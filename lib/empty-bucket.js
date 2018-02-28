const logger = require('./logger')
const co = require('co')
const emptyBucket = co.wrap(function* (s3, Bucket) {
  const deleteObjects = co.wrap(function* (objects) {
    // before we can delete the bucket, we must delete all versions of all objects
    const Objects = objects.map(({ Key, VersionId }) => ({ Key, VersionId }))

    yield s3.deleteObjects({
      Bucket,
      Delete: { Objects }
    }).promise()
  })

  let Versions
  try {
    // get the list of all objects in the bucket
    ({ Versions } = yield s3.listObjectVersions({ Bucket }).promise())
  } catch (err) {
    if (err.code === 'NoSuchBucket') return

    throw err
  }

  if (Versions.length > 0) {
    // if the bucket contains objects, delete them
    logger.info(`Deleting ${Versions.length} object versions`)
    yield deleteObjects(Versions)
  }

  // check for any files marked as deleted previously
  const { DeleteMarkers } = yield s3.listObjectVersions({ Bucket }).promise()

  if (DeleteMarkers.length > 0) {
    // if the bucket contains delete markers, delete them
    logger.info(`Deleting ${DeleteMarkers.length} object delete markers`)
    yield deleteObjects(DeleteMarkers)
  }

  // if there are any non-versioned contents, delete them too
  const { Contents } = yield s3.listObjectsV2({ Bucket }).promise()

  if (Contents.length > 0) {
    // if the bucket contains delete markers, delete them
    logger.info(`Deleting ${Contents.length} objects`)
    yield deleteObjects(Contents)
  }
})

module.exports = emptyBucket
