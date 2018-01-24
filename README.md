# @tradle/conf

CLI for managing your Tradle MyCloud instance

<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->


- [Usage](#usage)
  - [Install and load current configuration](#install-and-load-current-configuration)
  - [Customize](#customize)
    - [Custom Models and Lenses](#custom-models-and-lenses)
    - [Custom Styles](#custom-styles)
    - [Custom Bot Configuration](#custom-bot-configuration)
    - [Custom Terms & Conditions](#custom-terms-&-conditions)
  - [Deploy](#deploy)
    - [To your local development environment](#to-your-local-development-environment)
    - [To the cloud](#to-the-cloud)
  - [Lambda CLI](#lambda-cli)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

## Usage

this assumes you already deployed Tradle MyCloud to AWS, or are running a Tradle MyCloud development environment on your machine (see [@tradle/serverless](https://github.com/tradle/serverless))

### Install and load current configuration

1. Install `tradleconf` globally: `npm install -g @tradle/conf`
1. Initialize your configuration with `tradleconf init`. This will create a file called `.env`
1. Pull your remote configuration in with `tradleconf load --all`. Or pull in a specific part of it, e.g.:

`tradleconf load --models`  
`tradleconf load --style`  
`tradleconf load --bot`  
`tradleconf load --terms`  

### Customize

The following sections are optional, e.g. if you don't have Custom Models, skip the custom models section. If you don't have custom styles, skip the Custom Styles section, etc.

#### Custom Models and Lenses

See sample custom models in `./models-sample`. You can create your own in `./models` and lenses in `./lenses`. Put each model in a separate json file where the file name is [yourModel.id].json. See [./models-sample/my.custom.NameForm.json](./models-sample/my.custom.NameForm.json) and [./lenses-sample/my.custom.lens.PersonalInfo.json](./lenses-sample/my.custom.lens.PersonalInfo.json) for examples

Validate your models and lenses with `tradleconf validate --models`

#### Custom Styles

Define your provider's style in `./conf/style.json` (see [./conf/style.sample.json](./conf/style.sample.json)). Style must adhere to the [StylesPack](https://github.com/tradle/models/tree/master/models/tradle.StylesPack.json) model.

Validate your style with `tradleconf validate --style`

#### Custom Bot Configuration

Set your bot's configuration in `./conf/bot.json` (see [./conf/bot.sample.json](./conf/bot.sample.json)).

Validate your bot's configuration with `tradleconf validate --bot`

#### Custom Terms & Conditions

If you have Terms and Conditions you want your customers to accept prior to interacting with your bot, add them in `./conf/terms-and-conditions.md` (see [./conf/terms-and-conditions.sample.md](./conf/terms-and-conditions.sample.md))

### Deploy

You can deploy your configuration to your local Tradle development environment running on your machine, or to your Tradle MyCloud running in AWS.

#### To your local development environment

`tradleconf deploy --local --all`

Or if you only want to deploy a particular item:

- models: `tradleconf deploy --local --models`  
- styles: `tradleconf deploy --local --style`  
- bot configuration: `tradleconf deploy --local --bot`  
- terms and conditions: `tradleconf deploy --local --terms`  

#### To the cloud

Same as above, minus the `--local` flag

### Lambda CLI

Tradle MyCloud has a CLI lambda that understands a number of additional commands you can execute with:

`tradleconf exec <command>`

You can see a list of supported commands by executing the remote `help` command:

`tradleconf exec help`
