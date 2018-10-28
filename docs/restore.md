
## Restore

When you delete a stack, certain resources are retained: tables, buckets, keys. You can attach these to a new stack, via stack parameters.

If your data becomes corrupted, you can restore it to a point-in-time in the past. Then you can attach the restored resources to a new stack.

`tradleconf` can help you restore resources, generate parameters, and deploy new stacks.

### Restore a Dead Stack

This creates a new stack that points to an existing one's resources. At the moment, this stack cannot coexist with the original stack, so you will need to delete the existing stack first.

```sh
# short way
tradleconf restore-stack --new-stack-name tdl-mysstack1-ltd-dev
# long way
# gen stack parameters from a running or deleted stack
tradleconf gen-stack-parameters --output parameters.json
tradleconf restore-stack --new-stack-name tdl-mysstack1-ltd-dev --stack-parameters parameters.json
```

### Restore Resources to a Point in Time

*WARNING: there are still a few kinks to work out with this, so don't try it just yet*

```sh
# restore to point in time: buckets (except logs), tables
#   q: auto-name new tables, buckets?
tradleconf restore-resources --date "2018-10-25T00:00:00.000Z" --output parameters.json
# result:
# restored resources
# parameters.json with those resources prefilled
```

### Manually Restore a Stack

This is basically the same as the first section. If you restored some resources manually, you can generate the stack parameters, and then fill in your restored resources, before re-deploying

```sh
# gen stack parameters from a running or deleted stack
tradleconf gen-stack-parameters --output parameters.json
# edit parameters manually
# deploy a new stack with those parameters
tradleconf restore-stack --new-stack-name my-restored-stack --stack-parameters parameters.json
```
