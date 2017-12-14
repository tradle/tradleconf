#!/bin/bash

# unofficial bash strict mode
# http://redsymbol.net/articles/unofficial-bash-strict-mode/
set -euo pipefail
IFS=$'\n\t'

NO_ENV_ERROR="expected .env file with variables \"bucket\" and \"aws_profile\""

if [ ! -f ".env" ];
then
  echo "$NO_ENV_ERROR"
  exit 1
fi

source .env

if [ -z "$bucket" ] || [ -z "$aws_profile" ];
then
  echo "$NO_ENV_ERROR"
  exit 1
fi

key="custom-models.json"
params="--profile "$aws_profile" put-object \
  --bucket "$bucket" \
  --key "$key" \
  --content-type "application/json" \
  --body ./models.json"

s3="aws s3api"
if [ -n "$local" ]
then
  s3="$s3 --endpoint http://localhost:4572"
fi

echo "deploying your models to $bucket/$key with AWS profile $aws_profile"
eval "$s3" --profile "$aws_profile" put-object \
  --bucket "$bucket" \
  --key "$key" \
  --content-type "application/json" \
  --body ./models.json
