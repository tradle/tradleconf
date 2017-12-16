# @tradle/models-template

fork this module to create/edit/deploy your own custom Tradle models

<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->


- [Prerequisites](#prerequisites)
- [Usage](#usage)
  - [The first time](#the-first-time)
  - [The 2nd/nth time](#the-2ndnth-time)
- [Scripts](#scripts)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

## Prerequisites

- [aws-cli](https://github.com/aws/aws-cli) - AWS command line client

## Usage

this assumes you already deployed Tradle MyCloud to AWS

### The first time

1. run `npm install` in this directory
1. load your deployment information by running `npm run init`. This will create a file called `.env`
1. replace the sample models in `./models` with your own. Put each model in a separate json file with the file name is [yourModel.id].json (see [./models/my.custom.NameForm.json](./models/my.custom.NameForm.json) for an example)
1. validate and build your models pack with `npm run build:models`
1. define your provider's style in `./style.json` (see [./style.sample.json](./style.sample.json)). Style must adhere to the [StylesPack](https://github.com/tradle/models/tree/master/models/tradle.StylesPack.json) model.
1. validate your style with `npm run build:style`
1. set your bot's configuration in `./conf/bot.json` (see [./conf/bot.sample.json](./conf/bot.sample.json)).
1. validate your bot's configuration with `npm run build:botconf`
1. deploy with `npm run deploy`

Note: do NOT edit `./models.json` directly as it will be overwritten by `npm run build:models`

To deploy to your local Tradle development environment running on your machine, run `npm run deploy:local`

### The 2nd/nth time

run `npm start` and follow the wizard down the rabbit hole to nevernever land

## Scripts

- `npm run init`: set up your `.env` file
- `npm run mergemodels`: merges models from `./models` with values in `./values` and outputs `./models.json`
- `npm run validate`: validate your models and style
- `npm run build`: merge + validate your models, validate your style
- `npm run deploy`: deploy your models and style to your Tradle MyCloud's S3 bucket
- `npm run deploy:models`: deploy your models
- `npm run deploy:style`: deploy your style
- `npm run start`: init, build and deploy
