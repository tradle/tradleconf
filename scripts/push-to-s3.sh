#!/bin/bash

set -euo pipefail
IFS=$'\n\t'

getmd5() {
  if [ command -v md5 ]; then
    md5 -q "$key"
  elif [ command -v md5sum ]; then
    md5sum "$key" | awk '{ print $1 }'
  else
    # give up
    echo ""
  fi
}

source ./scripts/load-env.sh

for key in "$@"
do
  if [ -f "$key" ]; then
    echo "pushing $key"
    obj_head=$(eval $s3 head-object \
      --bucket "$bucket" \
      --key "$key" || echo '{}')

    # 2nd jq is to strip quotes
    etag=$(echo "$obj_head" | jq .ETag --raw-output | jq . --raw-output)
    obj_md5=$(md5sum "$key" | awk '{ print $1 }')
    if [ "$etag" == "$obj_md5" ]; then
      echo "$key content has not changed, skipping push"
    else
      eval $s3 put-object \
        --bucket "$bucket" \
        --key "$key" \
        --content-type "application/json" \
        --body "$key"
    fi
  else
    echo "$key doesn't exist, not pushing"
  fi
done
