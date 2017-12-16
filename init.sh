#!/bin/bash

set -euo pipefail
IFS=$'\n\t'

trim() {
  echo $1 | xargs
}

if [ -f ".env" ]
then
  read -p "This will overwrite your .env file. Continue? (y/n) " choice
  if [ "$choice" != "y" ];then exit 0; fi
fi

read -p "What AWS profile will you be using? " profile
profile=$(trim $profile)

echo ''
echo "looking up your stacks on AWS..."
stacks=$(aws --profile $profile cloudformation list-stacks \
  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE \
  | jq '.StackSummaries[].StackName' --raw-output)

echo "There are the stacks you have in AWS"
echo ''
echo "$stacks"
echo ''
read -p "Which one is your Tradle stack? " stack_name

echo ''
echo "looking up your configuration bucket..."
bucket=$(aws --profile $profile cloudformation list-stack-resources \
  --stack-name $stack_name \
  | jq '.StackResourceSummaries[] | select(.LogicalResourceId == "PrivateConfBucket").PhysicalResourceId' --raw-output)

echo ''
echo "your configuration bucket is: $bucket"
cat > .env <<EOF
stack_name=$stack_name
aws_profile=$profile
bucket=$bucket
EOF

cat > .env.local <<EOF
stack_name=$stack_name
aws_profile=$profile
bucket="$stack_name-privateconfbucket"
EOF

echo ''
echo "I wrote the following to .env:"
echo ''
cat .env
