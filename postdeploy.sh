#!/bin/bash

source ./load-env.sh

echo "poking your Tradle MyCloud to pick up new configuration"
echo "this may take 20-30 seconds"

if [ "$local" == "0" ]
then
  temp_file=$(mktemp)
  eval $lambda invoke \
    --invocation-type RequestResponse \
    --function-name "$stack_name-reinitialize-containers" \
    --region us-east-1 \
    --payload '{}' \
    --profile $aws_profile \
    "$temp_file"

  rm "$temp_file"
else
  echo "not invoking lambda locally"
fi
