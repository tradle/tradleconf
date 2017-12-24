#!/bin/bash

set -euo pipefail
IFS=$'\n\t'

trim() {
  echo $1 | xargs
}

if [ -f ".env" ]
then
  echo "This will overwrite your .env and .env.local files. Continue? (y/n)"
  read -p "> " choice
  if [ "$choice" != "y" ];then exit 0; fi
fi

echo "What AWS profile will you be using?"
echo "Hint: you can usually find this information in ~/.aws/config"
read -p "> " profile
profile=$(trim $profile)

echo ""
echo "looking up your stacks on AWS..."
stacks=$(aws --output json --profile $profile cloudformation list-stacks \
  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE \
  | jq '.StackSummaries[].StackName' --raw-output)

echo "These are the stacks you have in AWS:"
echo ""
echo "$stacks"
echo ""
echo "Which one is your Tradle stack?"
read -p "> " stack_name

echo ""
echo "looking up your configuration bucket..."
bucket=$(aws --output json --profile $profile cloudformation list-stack-resources \
  --stack-name $stack_name \
  | jq '.StackResourceSummaries[] | select(.LogicalResourceId == "PrivateConfBucket").PhysicalResourceId' --raw-output)

echo ""
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

echo ""
echo "Wrote .env and .env.local"
echo "Pulling current versions..."

source ./scripts/load-from-s3.sh

echo "Initialization complete!"
