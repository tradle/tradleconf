# Updates

Tradle regularly releases updates to MyCloud with bug fixes and features. To update, simply run: 

## How to Update

`tradleconf update`

and choose the version to update to. To include release candidates in the updates list, run: 

`tradleconf update -c`

If you already know the version you want to update to, run:

`tradleconf update --tag <versionTag>`

Note: you can also use the `update` command to roll back to previous versions. Bugfixes are the preferred resolution strategy, so such rollbacks are not part of our testing process. Use at your own risk!

## How it Works

1. Tradle releases a new version of MyCloud
2. Tradle sends update alerts to all child MyCloud deployments. Specifically a [tradle.cloud.VersionInfo](https://github.com/tradle/models-cloud/blob/master/models/tradle.cloud.VersionInfo.json) object is sent.
3. A child MyCloud, upon receiving `tradle.cloud.VersionInfo` from Tradle, alerts its own admin via email.
4. * The child MyCloud's admin uses tradleconf to update her deployment to the latest tag: `tradleconf update --version <insert-tag>`.
5. The child MyCloud sends a [tradle.cloud.UpdateRequest](https://github.com/tradle/models-cloud/blob/master/models/tradle.cloud.UpdateRequest.json) to Tradle's MyCloud.
6. Tradle's MyCloud copies lambda code for the requested version to a bucket in the child's region, generates a template for the requested version, and sends back an [tradle.cloud.UpdateResponse](https://github.com/tradle/models-cloud/blob/master/models/tradle.cloud.UpdateResponse.json)
7. `tradleconf` applies the update using the admin's AWS credentials.

* If the child admin doesn't wish to update MyCloud at this time, she can always run `tradleconf update` at a later time, and choose from available updates.
