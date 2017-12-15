# @tradle/models-template

Fork this module to create/edit/deploy your own custom Tradle models

<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->


- [Prerequisites](#prerequisites)
- [Usage](#usage)
- [Scripts](#scripts)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

## Prerequisites

- [aws-cli](https://github.com/aws/aws-cli) - AWS command line client

## Usage

1. write your models in `./models`, each model in a separate json file with the file name [myModel.id].json (see [./models/my.custom.NameForm.json](./models/my.custom.NameForm.json) for an example)
1. build your models with `npm run build` (merge + validate)
1. define your style in `./style.json` (see [./style.sample.json](./style.sample.json)). Style must adhere to the [StylesPack](https://github.com/tradle/models/tree/master/models/tradle.StylesPack.json) model. 
1. set your bot's configuration in `./conf.json` (see [./bot-conf.sample.json](./bot-conf.sample.json)).
1. create a `.env` file a la [.env.sample](./.env.sample)
1. deploy with `npm run deploy`

Note: do NOT edit `./models.json` directly as it will be overwritten by `npm run mergemodels`

To deploy locally, create a `.env.local` file and deploy with `local=1 npm run deploy`

## Scripts

- `npm run mergemodels`: merges models from `./models` with values in `./values` and outputs `./models.json`
- `npm run validate`: validate your models and style
- `npm run build`: merge + validate your models, validate your style
- `npm run deploy`: deploy your models and style to your Tradle MyCloud's S3 bucket
- `npm run deploy:models`: deploy your models
- `npm run deploy:style`: deploy your style
