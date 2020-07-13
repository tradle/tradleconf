# @tradle/conf

CLI for managing your Tradle MyCloud instance

<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->


- [Prerequisites](#prerequisites)
  - [AWS Account](#aws-account)
  - [Launch a MyCloud instance](#launch-a-mycloud-instance)
  - [AWS cli & credentials](#aws-cli--credentials)
  - [AWSLogs (optional)](#awslogs-optional)
- [Install and load current configuration](#install-and-load-current-configuration)
- [Updating tradleconf](#updating-tradleconf)
- [Customize](#customize)
  - [Custom Models and Lenses](#custom-models-and-lenses)
  - [Custom Styles](#custom-styles)
  - [Custom Bot Configuration (and plugins)](#custom-bot-configuration-and-plugins)
  - [Custom Terms and Conditions](#custom-terms-and-conditions)
  - [Custom KYC Services](#custom-kyc-services)
- [Deploy](#deploy)
  - [To your local development environment](#to-your-local-development-environment)
  - [To the cloud](#to-the-cloud)
- [Updating MyCloud](#updating-mycloud)
  - [MyCloud Release Schedule](#mycloud-release-schedule)
- [Destroy](#destroy)
- [Restore](#restore)
- [Logging](#logging)
- [Common Commands](#common-commands)
  - [Get web/mobile app links, deployment info, blockchain address](#get-webmobile-app-links-deployment-info-blockchain-address)
  - [Load remote models, styles and configuration](#load-remote-models-styles-and-configuration)
  - [Push bot/plugins configuration](#push-botplugins-configuration)
  - [Set admin email for alerts](#set-admin-email-for-alerts)
  - [Change database autoscaling](#change-database-autoscaling)
  - [Disable MyCloud](#disable-mycloud)
  - [Set days before logs transition to Amazon Glacier](#set-days-before-logs-transition-to-amazon-glacier)
  - [Set days before logs are deleted permanently](#set-days-before-logs-are-deleted-permanently)
- [Blockchain](#blockchain)
  - [Balance](#balance)
  - [Sealing Mode](#sealing-mode)
- [Alerts](#alerts)
- [Built-in Plugins](#built-in-plugins)
  - [Terms and Conditions](#terms-and-conditions)
  - [Lens](#lens)
  - [Prefill form](#prefill-form)
  - [ComplyAdvantage](#complyadvantage)
  - [OpenCorporates](#opencorporates)
  - [Onfido](#onfido)
  - [Centrix](#centrix)
  - [Document Checker](#document-checker)
  - [TrueFace](#trueface)
  - [RankOne](#rankone)
  - [FacialRecognition](#facialrecognition)
  - [DocumentValidity](#documentvalidity)
  - [Customize message](#customize-message)
  - [Webhooks](#webhooks)
  - [Deployment](#deployment)
  - [Conditional auto-approve](#conditional-auto-approve)
  - [Sme onboarding](#sme-onboarding)
  - [Sme auto-approve](#sme-auto-approve)
  - [Data Import / Remediation](#data-import--remediation)
  - [Required Forms](#required-forms)
  - [Controlling person registration](#controlling-person-registration)
  - [Controlling entity validation](#controlling-entity-validation)
  - [Verify Phone Number](#verify-phone-number)
  - [Client Edits](#client-edits)
- [Troubleshooting](#troubleshooting)
  - [tradleconf update](#tradleconf-update)
  - [tradleconf enable-kyc-services](#tradleconf-enable-kyc-services)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

### Prerequisites

#### AWS Account

*Note: optional if you only plan on running MyCloud in development mode on your machine.*

If you don't have one yet, get one. There's a pretty generous free tier.

#### Launch a MyCloud instance

*Note: optional if you only plan on running MyCloud in development mode on your machine.*

Click [here](https://app.tradle.io/#/applyForProduct?provider=9658992cbb1499c1fd9f7d92e1dee43eb65f403b3a32f2d888d2f241c4bdf7b6&host=https%3A%2F%2Ft22ju1ga5c.execute-api.us-east-1.amazonaws.com%2Fdev&product=tradle.cloud.Deployment). You'll be prompted to fill out a MyCloud configuration form. When you do, you'll be given a launch link. Follow it to launch your MyCloud in AWS.

While you wait, read on.

*Note: currently, the following regions are supported: US East (Virginia), Asia Pacific (Singapore), or Asia Pacific (Sydney). If you need to launch in a different region, please submit an issue on this repository. For most, we can provision support at a moment's notice.*

#### AWS cli & credentials

1. [Install](http://docs.aws.amazon.com/cli/latest/userguide/installing.html)
1. create a new IAM user with AdministratorAccess
1. Configure your credentials: `aws configure` or `aws configure --profile <profileName>`. This will set up your AWS credentials in `~/.aws/`

#### AWSLogs (optional)

If you want to inspect logs from your lambda functions in realtime, you'll need to install [awslogs](https://github.com/jorgebastida/awslogs), as the command `tradleconf log` uses awslogs underneath.

### Install and load current configuration

Note: the below instructions are for managing a single MyCloud instance.

1. Install `tradleconf` globally: `npm install -g @tradle/conf` (you may need `sudo` depending on how you installed Node.js)
1. Create a new directory in which you will keep your configuration. In it, initialize your configuration with `tradleconf init`. This will create a file called `.env`
1. Pull your remote configuration in with `tradleconf load --all`. Or pull in a specific part of it, e.g.:

`tradleconf load --models`
`tradleconf load --style`
`tradleconf load --bot`
`tradleconf load --terms`

### Updating tradleconf

Try to use the latest version of `tradleconf` at all times. `tradleconf` checks for updates as you use it, but at any time, you can update it yourself in the same way you installed it (see the [Install](#install-and-load-current-configuration) section)

### Customize

The following sections are optional, e.g. if you don't have Custom Models, skip the custom models section. If you don't have custom styles, skip the Custom Styles section, etc.

#### Custom Models and Lenses

See sample custom models in `./models-sample`. You can create your own in `./models` and lenses in `./lenses`. Put each model in a separate json file where the file name is [yourModel.id].json. See [./models-sample/my.custom.NameForm.json](./models-sample/my.custom.NameForm.json) and [./lenses-sample/my.custom.lens.PersonalInfo.json](./lenses-sample/my.custom.lens.PersonalInfo.json) for examples

#### Custom Styles

Define your provider's style in `./conf/style.json` (see [./conf/style.sample.json](./conf/style.sample.json)). Style must adhere to the [StylesPack](https://github.com/tradle/models/tree/master/models/tradle.StylesPack.json) model.

See more details and screenshots for styles [here](https://github.com/tradle/tradleconf/blob/master/docs/data-import.md)

#### Custom Bot Configuration (and plugins)

Set your bot's configuration in `./conf/bot.json`. See [./conf/bot.sample.json](./conf/bot.sample.json) for an example. Also, see the [Plugins](#built-in-plugins) section for how to configure the currently available plugins.

#### Custom Terms and Conditions

If you have Terms and Conditions you want your customers to accept prior to interacting with your bot, add them in `./conf/terms-and-conditions.md` (see [./conf/terms-and-conditions.sample.md](./conf/terms-and-conditions.sample.md))

You will also need to add a block in the `plugins` block in `conf/bot.json` to enable/disable the T's and C's. See the [plugin configuration](#terms-&-conditions) below.

#### Custom KYC Services

Several of the services Tradle pre-integrates with need to be enabled explicitly before use, and are launched in a separate AWS cloudformation stack.

To enable/update them, run:

`tradleconf enable-kyc-services`

After the command completes (~20 minutes), you'll be able to configure the respective plugins

To specify which kyc services to enable, run:

`tradleconf set-kyc-services --name1 --name2` (run `tradleconf set-kyc-services --help` to see what's available)

To delete your kyc-services stack (it's stateless, so you can always create a new one):

`tradleconf disable-kyc-services`

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

### Updating MyCloud

See [docs/updates.md](docs/updates.md)

#### MyCloud Release Schedule

Releases follow [semver](http://semver.org). A version like `1.9.4` represents `MAJOR.MINOR.PATCH` or in other words `MAJOR.FEATURE.BUGFIX`. For example:

- `1.1.7 -> 1.1.8` is bug fix release
- `1.1.7 -> 1.2.0` is a feature release

In between releases, there are release candidates, which are experimental pre-releases of bugfixes or features for those who like to live on the bleeding edge.

Release candidates end with `-rc.X`, e.g. `1.9.0-rc.1000`

Release candidates come *before* the version they're a candidate for:

```
1.9.0 -> 1.9.0-rc.1000
1.9.1-rc.0 -> 1.9.1
1.9.1-rc.20 -> 1.9.1
```

A sample timeline goes like this, with releases in bold:

```sh
1.8.3       # BUGFIX RELEASE
1.9.0-rc.0  # pre-release new feature
1.9.0-rc.1  # pre-release bugfix
1.9.0-rc.2  # pre-release another bugfix
#           # ...
1.9.0-rc.7  # bugs fixed, new feature stabilized, ready for release
1.9.0       # REGULAR FEATURE RELEASE
1.9.1-rc.0  # pre-release bugfix
1.9.1       # REGULAR BUGFIX RELEASE
#           # ...
1.9.13
1.10.0-rc.0 # pre-release new feature
1.10.0-rc.1 # pre-release bugfix
1.10.1      # REGULAR BUGFIX RELEASE
# ...
```

### Destroy

If murder is in your heart, you can destroy your Tradle MyCloud irreversibly using `tradleconf destroy`

### Restore

For whatever reasons, sometimes you may want to restore a failed or corrupted stack, and even restore your data to a point in time. See the [Restore](./restore.md) documentation.

### Logging

```sh
tradleconf log onmessage -s 5m # log onmessage since 5m ago
tradleconf tail onmessage -s 5m # log onmessage since 5m ago, tail
tradleconf log -s 5m # log some function (you'll get a chooser prompt)
tradleconf log --help # get additional tips
```

### Common Commands

#### Get web/mobile app links, deployment info, blockchain address

`tradleconf info --remote`

sample response:

```json
{
  "links": {
    "result": {
      "mobile": "https://link.tradle.io/chat?provider=569a4dc1fc69f6137dede81ca0ff77c1a5feb0f4a7bdc73e0007f5ed3a1d1f60&host=https%3A%2F%2Ftv5n42vd5f.execute-api.us-east-1.amazonaws.com%2Fdev",
      "web": "https://app.tradle.io/#/chat?provider=569a4dc1fc69f6137dede81ca0ff77c1a5feb0f4a7bdc73e0007f5ed3a1d1f60&host=https%3A%2F%2Ftv5n42vd5f.execute-api.us-east-1.amazonaws.com%2Fdev",
      "employeeOnboarding": "https://app.tradle.io/#/applyForProduct?provider=569a4dc1fc69f6137dede81ca0ff77c1a5feb0f4a7bdc73e0007f5ed3a1d1f60&host=https%3A%2F%2Ftv5n42vd5f.execute-api.us-east-1.amazonaws.com%2Fdev&product=tradle.EmployeeOnboarding"
    }
  },
  "version": {
    "commit": "c403d33",
    "version": "1.0.0",
    "branch": "master"
  },
  "chainKey": {
    "type": "ethereum",
    "pub": "04d7ad3d714dac85ee6f91381eeb688c0d8766c274400a4ecae6a29896ee83e4221f880fc0d2bc6adc0647c043e0683daada1d2ccf7a9e3e7170400ed63b69e7fa",
    "fingerprint": "fe134e1332f37b8bb8df74c0aa60c2d4b3e6e1f4",
    "networkName": "rinkeby"
  },
  "apiBaseUrl": "https://tv5n42vd5f.execute-api.us-east-1.amazonaws.com/dev"
}
```

#### Load remote models, styles and configuration

`tradleconf load --remote`

#### Push bot/plugins configuration

`tradleconf deploy --remote --bot`

#### Set admin email for alerts

`tradleconf set-admin-email --email <email>`

#### Change database autoscaling

Command to let you change to the new on-demand autoscaling:

`tradleconf set-db-autoscaling --on-demand`

*Note: changing to on-demand autoscaling is a strictly throttled DB configuration operation*

to revert:

`tradleconf set-db-autoscaling --provisioned`

#### Disable MyCloud

If for some reason or other, you need to disable your deployment temporarily, you can run:

`tradleconf disable ---remote`

This will turn most of your cloud functions off. Mobile/web clients will be unable to reach your MyCloud.

To re-enable your deployment, you run:

`tradleconf enable --remote`

#### Set days before logs transition to Amazon Glacier

`tradleconf set-logs-transition --days <days>`

#### Set days before logs are deleted permanently

`tradleconf set-logs-ttl --days <days>`

### Blockchain

#### Balance

To check your address and balance, you can use the `balance` command, e.g.:

`tradleconf balance --remote`

To top up, send funds to that address. Make sure you're sending funds on the right blockchain network!

Funds are typically specified in the lowest unit of the particular blockchain, e.g. in satoshis for bitcoin, and wei for ethereum.

#### Sealing Mode

By default, MyCloud seals in 'single' sealing mode, meaning it seals objects individually. If you're up to MyCloud version `v2.3.0`, you can change the sealing mode to 'batch'. For example, to batch objects every 10 minutes, and create one seal per batch, you would run:

`tradleconf set-sealing-mode --mode batch --period-in-minutes 10`

To switch back to 'single' mode:

`tradleconf set-sealing-mode --mode single`

### Alerts

After deploying MyCloud (and sometimes after a major update), you will receive an email from AWS at the admin email address you specified, asking you to confirm an SNS subscription (Amazon's Simple Notification Service). If you want your MyCloud to alert you when its balance is low, and/or about other issues, confirm that subscription.

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
#### Document Checker

Provider: DocumentChecker
Purpose: Check authenticity of the Photo ID document using Keesing Document Checker.

Example config:

```js
// ...
"plugins": {
  // ...
  "documentChecker": {
    "account": "...",
    "username": "...",
    "test": true
  }
}
```
#### TrueFace

Provider: TrueFace
Purpose: detect whether a selfie is a spoof

Example config:

```js
// ...
"plugins": {
  // ...
  "trueface": {
    "token": "...",
    "products": {
      "nl.tradle.DigitalPassport": [
        "tradle.Selfie"
      ],
      "tradle.CertifiedID": [
        "tradle.Selfie"
      ]
    }
  }
}
```

#### RankOne

Provider: RankOne
Purpose:
- compare photo id vs selfie photo for similarity
- analyze a photo with a face, extract various information such as demographics and orientation

Example config:

```js
// ...
"plugins": {
  // ...
  "rankone-checks": {
    // no options at the moment
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

#### DocumentValidity

Purpose: upon receiving PhotoID form, check the validity of expiration date, viable age, countries of nationality and issuer if applicable

Example config:

```js
// ...
"plugins": {
  // ...
  "documentValidity": {
  }
  // ...
}
```

#### Customize message

Purpose: customize the messages for various types sent to the user (e.g. form requests)

Example config:

```js
// ...
"plugins": {
  // ...
  "customize-message": {
    "tradle.FormRequest": {
      "tradle.ProductRequest": "See our list of products",
      "tradle.TermsAndConditions": "Please review our Terms and Conditions",
      "tradle.PhotoID": "Please click to scan your **ID document**",
      "tradle.Selfie": "Thank you. Now take a '**selfie**' photo of yourself that I can match against your ID document",
      "tradle.Residence": {
        "first": "Thank you. Now I need you to provide your **residence** information",
        "nth": "Thank you. Do you have another **residence**? If yes, tap Add, otherwise tap Next"
      },
      "tradle.ApplicationSubmitted": {
        "tradle.nl.DigitalPassport": "You're all done! We'll get back to you shortly"
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
      // ... get notified about inbound messages of a particular type
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

#### Deployment

Purpose: required to support the `tradle.cloud.Deployment` product. This product allows others to deploy MyCloud children based on your own MyCloud

Example config:

```js
// ...
"plugins": {
  // ...
  "deployment": {
    "senderEmail": "[an email address you control]",
    "replication": {
      "regions": [
        // regions you want to support
        "us-east-1",
        "ap-southeast-2"
      ]
    }
  }
}
```
#### Conditional auto-approve

Purpose: allow to auto approve customer application if all the listed checks passed
```js
...
"plugins": {
  // ...
  "conditional-auto-approve": {
    "products": {
      "tradle.CertifiedID": [
        // List of checks that need to 'Pass' in order to auto-approve the application
        "tradle.SanctionsCheck",
        "tradle.DocumentValidityCheck",
        ...
      ],
      "tradle.CorporateBankAccount": [
        "tradle.CorporationExistsCheck",
        "tradle.SanctionsCheck",
        ...
      ]
    }
  }
}
```
#### Sme onboarding

Purpose: allow to prefill subsidiary application from associated resource created when main application was submitted
```js
...
"plugins": {
  // ...
  "sme-onboarding": {}
}
```
#### Sme auto-approve

Purpose: allow to auto approve SME application if all child applications (subsidiaries, controlling persons) were approved
```js
...
"plugins": {
  // ...
  "sme-auto-approve": [
    {
      "child": "tradle.legal.ControllingPersonOnboarding",
      "parent": "tradle.legal.LegalEntity"
    },
    ...
  ]
}
```
#### Data Import / Remediation

If you already have data from a customer and don't want them to re-enter it, you can have them import it in their Tradle app by scanning a QR code. To create the data bundle and claim stub, see  [./docs/data-import.md](https://github.com/tradle/tradleconf/blob/master/docs/data-import.md)

#### Required Forms

Purpose: customize a product's required forms

Example config:

```js
// ...
"plugins": {
  // ...
  "required-forms": {
    "tradle.EmployeeOnboarding": [
      "tradle.PhotoID"
    ]
  }
}
```
#### Controlling person registration

Purpose: When SME administrator fills out CP and CE for officers and beneficial owners (BO) of the company, the notification should be sent out for the corresponding officer and/or BO to get onboarded
```js
...
"plugins": {
  // ...
  "controllingPersonRegistration": {
    "senderEmail": "...",
    "products": {
      "io.lenka.LegalEntity": [
        "tradle.legal.LegalEntityControllingPerson"
      ],
      ...
    }
  }
}
```
#### Controlling entity validation

Purpose: When SME administrator fills out CP and CE for officers and beneficial owners (BO) of the company, the notification should be sent out for the corresponding officer and/or BO to get onboarded
```js
...
"plugins": {
  // ...
  "controllingEntityValidation": {
    "senderEmail": "...",
    "products": {
      "io.lenka.LegalEntity": [
        "tradle.legal.LegalEntityControllingPerson"
      ],
      ...
    }
  }
}
```
#### Verify Phone Number

Purpose: verify a user controls a phone number

Example config:

```js
// ...
"plugins": {
  // ...
  "verify-phone-number": {
    "products": {
      "tradle.CurrentAccount": {
        "tradle.PersonalInfo": {
          "property": "phones"
        }
      }
    }
  }
}
```
#### Client Edits

Purpose:

### Troubleshooting

#### tradleconf update

**Symptom**: InvalidInput: expected "adminEmail"
**Cause**: in MyCloud <= 2.3.0, you need to confirm the AWS SNS Subscription for Alerts. Look for an email with subject "AWS Notification - Subscription Confirmation" and confirm it. If the confirmation expired, go to the AWS SNS Console for your AWS region (e.g. https://console.aws.amazon.com/sns/v2/home?region=us-east-1#/topics), find the topic that looks like `[your-stack-name]-alerts-alarm` (e.g. `tdl-tradle-ltd-dev-alerts-alarm`), and create and confirm an Email subscription to that topic.

#### tradleconf enable-kyc-services

This command creates an additional CloudFormation stack. Should it fail when you run it, find the failed stack in the AWS CloudFormation console, and ask the Tradle team to help you interpret the error.

In general, this stack is stateless (doesn't store any data), so it's safe to delete and re-create.
