#!/bin/bash

set -euo pipefail
IFS=$'\n\t'
export AWS_DEFAULT_OUTPUT="json"

if [ ! -f ".env" ];
then
  source ./scripts/init.sh
fi

npm run build

# if [ ! -f 'conf/models.json' ]
# then
#   echo "you haven't defined any custom models!"
# fi

# if [ ! -f 'conf/style.json' ]
# then
#   echo "you haven't defined any custom styles!"
# fi

# if [ ! -f 'conf/bot.json' ]
# then
#   echo "you haven't defined any custom bot configuration!"
# fi

npm run deploy
