#!/bin/bash

set -euo pipefail
IFS=$'\n\t'

source ./scripts/load-env.sh

files=(
  "conf/style.json"
  "conf/bot.json"
  "conf/models.json"
)

for key in ${files[@]}
do
  echo "downloading $key"
  eval $s3 get-object \
    --bucket "$bucket" \
    --key "$key" \
    "./$key" || echo "$key not found"
done
