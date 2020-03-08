#!/bin/bash

tsc -b
VERSION=$(cat package.json | jq -r .version)
docker build -t tradle/conf:$VERSION . 
docker tag tradle/conf:$VERSION tradle/conf:latest
