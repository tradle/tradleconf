#!/bin/bash

set -euo pipefail
IFS=$'\n\t'

source ./scripts/load-env.sh

files=(
  "conf/style.json"
  "conf/bot.json"
  "conf/models.json"
  "conf/terms-and-conditions.md"
)

for key in ${files[@]}
do
  echo "downloading $key"
  eval $s3 get-object \
    --bucket "$bucket" \
    --key "$key" \
    "./$key" >/dev/null 2>&1 || echo "$key not found"
done
