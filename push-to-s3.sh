#!/bin/bash

set -euo pipefail
IFS=$'\n\t'

source ./load-env.sh

for key in "$@"
do
  if [ -f "$key" ]
  then
    echo "pushing $key"
    eval $s3 put-object \
      --bucket "$bucket" \
      --key "$key" \
      --content-type "application/json" \
      --body "$key"
  else
    echo "$key doesn't exist, not pushing"
  fi
done
