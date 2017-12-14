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

s3="aws s3api"
if [ -n "$local" ]
then
  s3="$s3 --endpoint http://localhost:4572"
fi

