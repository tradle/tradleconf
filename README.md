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
    - [Custom Terms and Conditions](#custom-terms-and-conditions)
  - [Deploy](#deploy)
    - [To your local development environment](#to-your-local-development-environment)
    - [To the cloud](#to-the-cloud)
  - [Destroy](#destroy)
  - [Logging](#logging)
  - [Lambda CLI](#lambda-cli)
  - [Built-in Plugins](#built-in-plugins)
    - [Terms and Conditions](#terms-and-conditions)
    - [Lens](#lens)
    - [Prefill form](#prefill-form)
    - [ComplyAdvantage](#complyadvantage)
    - [OpenCorporates](#opencorporates)
    - [Onfido](#onfido)
    - [Centrix](#centrix)
    - [Customize message](#customize-message)
    - [Webhooks](#webhooks)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

## Usage

this assumes you already deployed Tradle MyCloud to AWS, or are running a Tradle MyCloud development environment on your machine (see [@tradle/serverless](https://github.com/tradle/serverless))

### Install and load current configuration

1. Install `tradleconf` globally: `npm install -g @tradle/conf`
1. Create a new directory in which you will keep your configuration. In it, initialize your configuration with `tradleconf init`. This will create a file called `.env`
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

Set your bot's configuration in `./conf/bot.json`. See [./conf/bot.sample.json](./conf/bot.sample.json) for an example. Also, see the [Plugins](#built-in-plugins) section for how to configure the currently available plugins.

Validate your bot's configuration with `tradleconf validate --bot`

#### Custom Terms and Conditions

If you have Terms and Conditions you want your customers to accept prior to interacting with your bot, add them in `./conf/terms-and-conditions.md` (see [./conf/terms-and-conditions.sample.md](./conf/terms-and-conditions.sample.md))

You will also need to add a block in the `plugins` block in `conf/bot.json` to enable/disable the T's and C's. See the [plugin configuration](#terms-&-conditions) below.

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

Same as above, minus the `--local` flag. You will be asked for confirmation unless you add the `--remote` flag.

### Destroy

If murder is in your heart, you can destroy your Tradle MyCloud irreversibly using `tradleconf destroy`

### Logging

```sh
tradleconf log onmessage -s 5m # log onmessage since 5m ago
tradleconf tail onmessage -s 5m # log onmessage since 5m ago, tail
tradleconf log -s 5m # log some function (you'll get a chooser prompt)
tradleconf log --help # get additional tips
```

### Lambda CLI

Tradle MyCloud has a CLI lambda that understands a number of additional commands you can execute with:

`tradleconf exec <command>`

You can see a list of supported commands by executing the remote `help` command:

`tradleconf exec help`

Note: make sure to quote your command if it has any whitespace, e.g.:

`tradleconf exec "help setproductenabled"`  
`tradleconf exec "setproductenabled tradle.CurrentAccount false"`  
`tradleconf exec "addfriend https://bob.com --domain bob.com"`

### Built-in Plugins

Find below annotated examples from [./conf/bot.sample.json](./conf/bot.sample.json)

#### Terms and Conditions

Purpose: require new users to accept T's and C's before anything else

Prerequisite: deploy terms and conditions as described [above](#custom-terms-and-conditions)

Example config:

```js
// ...
"plugins": {
  // ...
  "termsAndConditions": {
    "enabled": true
  }
}
```

#### Lens

Purpose: request common forms with custom lenses

Example config:

```js
// ...
"plugins": {
  // ...
  "lens": {
    // for the nl.tradle.DigitalPassport product...
    "nl.tradle.DigitalPassport": {
      // when requesting form tradle.PhotoID, specify lens io.safere.lens.PhotoID
      "tradle.PhotoID": "io.safere.lens.PhotoID"
    }
  }
}
```

#### Prefill form

Purpose: prefill forms sent to the user with sensible defaults

Example config:

```js
// ...
"plugins": {
  // ...
  "prefillForm": {
    // for the nl.tradle.DigitalPassport product...
    "nl.tradle.DigitalPassport": {
      // when requesting form tradle.PhotoID, prefill country to New Zealand
      "tradle.PhotoID": {
        "country": {
          "id": "tradle.Country_NZ"
        }
      }
    }
  }
}
```

#### ComplyAdvantage

Purpose: upon receiving certain forms from the user, trigger checks using Comply Advantage API

Example config:

```js
// ...
"plugins": {
  // ...
  "complyAdvantage": {
    "credentials": {
      "apiKey": "..."
    },
    "products": {
      // for the tradle.CordaKYC product...
      "tradle.CordaKYC": {
        "filter":  {
          "fuzziness": 1,
          "filter": {
            "types": ["sanction"]
          }
        },
        // Create a property map you want to use for running this check.
        // Property map's values are the property in the form and keys how they named in plugin.
        // Properties could be derived from different forms. 
        // Here is an example when data are derived from one form the tradle.BusinessInformation 
        // with the following ComplyAdvantage API settings:
        "propertyMap": {
          "tradle.BusinessInformation": {
            "companyName": "companyName",
            "registrationDate": "registrationDate"
          }
        }
      }
    }
  }
} 
```

#### OpenCorporates

Purpose: upon receiving certain forms from the user, trigger checks using OpenCorporates

Example config:

```js
// ...
"plugins": {
  // ...
  "openCorporates": {
    "apiKey": "...",
    "products": {
      "tradle.CordaKYC": [
        "tradle.BusinessInformation"
      ]
    }
  }
} 
```

#### Onfido

Purpose: upon receiving certain forms from the user, trigger checks using Onfido

Note: currently this is available only for the products tradle.onfido.CustomerVerification and tradle.pg.CustomerOnboarding. Will be generally available soon.

Example config:

```js
// ...
"plugins": {
  // ...
  "onfido": {
    "apiKey": "..."
  }
}
```

#### Centrix

Purpose: upon receiving certain forms from the user, trigger checks using Centrix

Example config:

```js
// ...
"plugins": {
  // ...
  "centrix": {
    "credentials": {
      "test": true, // use test server
      "httpCredentials": {
        "username": "...",
        "password": "..."
      },
      "requestCredentials": {
        "subscriberId": "...",
        "userId": "...",
        "userKey": "..."
      }
    },
    "products": {
      "nl.tradle.DigitalPassport": {}
    }
  }
}
```

#### FacialRecognition

Purpose: upon receiving PhotoID and Selfie forms, trigger checks using NtechLab Facial Recognition

Example config:

```js
// ...
"plugins": {
  // ...
  "facial-recognition": {
    "url": "http://...", // URL ntechlab server
    "token": "...",
    "threshold": "strict"
  }
}
```
To test it you need to run local tunnel

`lt -p 4572 -s pick-a-hostname`

It will return url that you pass as a parameter to your local server

`S3_PUBLIC_FACING_HOST=https://pick-a-hostname.localtunnel.me node --debug --inspect --max_old_space_size=4096 ./node_modules/.bin/sls offline start`

#### Customize message

Purpose: customize the messages for various types sent to the user (e.g. form requests)

Example config:

```js
// ...
"plugins": {
  // ...
  "customize-message": {
    "tradle.FormRequest": {
      "tradle.PhotoID": "Please click to scan your **ID document**",
      "tradle.Selfie": "Thank you. Now take a '**selfie**' photo of yourself that I can match against your ID document",
      "tradle.Residence": {
        "first": "Thank you. Now I need you to provide your **residence** information",
        "nth": "Thank you. Do you have another **residence**? If yes, tap Add, otherwise tap Next"
      }
    }
  }
}
```

#### Webhooks

Purpose: subscribe to events, handle them outside MyCloud

Example config:

```js
// ...
"plugins": {
  // ...
  "webhooks": {
    // optional. If provided, webhook requests will carry an hmac of the body
    // in the x-webhook-auth header (see ./examples/webhook-handler.js)
    "hmacSecret": "[a private random string]",
    // subscriptions to events you want to receive
    "subscriptions": [
      // ... get notified about all inbound messages
      {
        "topic": "msg:i",
        "endpoint": "https://example.com/tradle/webhook1"
      },
      // ... get notified about inbound messages of a particular time
      {
        "topic": "msg:i:tradle.PhotoID",
        "endpoint": "https://example.com/tradle/webhook2"
      },
      // ... get notified when a resource is saved
      {
        "topic": "save",
        "endpoint": "https://example.com/tradle/webhook3"
      },
      // ... get notified when a particular type of resource is saved
      {
        "topic": "save:tradle.Application",
        "hmacSecret": "use a different hmacSecret per subscriptin if you want",
        "endpoint": "https://example.com/tradle/webhook4"
      }
    ]
  }
}
```

See an example webhook processor in [./examples/webhooks](./examples/webhooks/index.js). To run it:

```sh
cd examples/webhooks
npm install
npm start
```
