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
2. build your models with `npm run build` (merge + validate)
3. create a `.env` file a la [.env.sample](./.env.sample)
4. deploy with `npm run deploy`

Note: do NOT edit `./models.json` directly as it will be overwritten when you merge

## Scripts

- `npm run merge`: merges models from `./models` with values in `./values` and outputs `./models.json`
- `npm run validate`: validates your models
- `npm run build`: merge + validate your models
- `npm run deploy`: deploys your models to your Tradle MyCloud's S3 bucket that holds your bot's configuration
