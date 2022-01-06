<p align="center">
  <a href="https://circleci.com/gh/SetProtocol/set-v2-strategies/tree/master">
    <img src="https://img.shields.io/circleci/project/github/SetProtocol/set-v2-strategies/master.svg" />
  </a>
  <a href='https://coveralls.io/github/SetProtocol/set-v2-strategies?branch=master'><img src='https://coveralls.io/repos/github/SetProtocol/set-v2-strategies/badge.svg?branch=master&amp;t=4pzROZ' alt='Coverage Status' /></a>
</p>

# Set V2 Strategies Contract Repository

## Contracts
This repo contains management contracts for assets built with [Set Protocol](https://setprotocol.com/). It uses [Hardhat](https://hardhat.org/) as a development environment for compiling, testing, and deploying.

## Development

To use console.log during Solidity development, follow the [guides](https://hardhat.org/guides/hardhat-console.html).

## Available Functionality

### Run Hardhat EVM

`yarn chain`

### Build Contracts

`yarn compile`

### Generate TypeChain Typings

`yarn build`

### Run Contract Tests

`yarn test` to run compiled contracts

OR `yarn test:clean` if contracts have been typings need to be updated

### Run Coverage Report for Tests

`yarn coverage`

## Installing from `npm`

We publish our contracts as well as [hardhat][22] and [typechain][23] compilation artifacts to npm.

```
npm install @setprotocol/set-v2-strategies
```

[22]: https://www.npmjs.com/package/hardhat
[23]: https://www.npmjs.com/package/typechain

## Contributing
We highly encourage participation from the community to help shape the development of Set. If you are interested in developing on top of Set Protocol or have any questions, please ping us on [Discord](https://discord.gg/ZWY66aR).

## Security

### TODO: Independent Audits

### Code Coverage

All smart contracts are tested and have 100% line and branch coverage.

### Vulnerability Disclosure Policy

The disclosure of security vulnerabilities helps us ensure the security of our users.

**How to report a security vulnerability?**

If you believe you’ve found a security vulnerability in one of our contracts or platforms,
send it to us by emailing [security@setprotocol.com](mailto:security@setprotocol.com).
Please include the following details with your report:

* A description of the location and potential impact of the vulnerability.

* A detailed description of the steps required to reproduce the vulnerability.

**Scope**

Any vulnerability not previously disclosed by us or our independent auditors in their reports.

**Guidelines**

We require that all reporters:

* Make every effort to avoid privacy violations, degradation of user experience,
disruption to production systems, and destruction of data during security testing.

* Use the identified communication channels to report vulnerability information to us.

* Keep information about any vulnerabilities you’ve discovered confidential between yourself and
Set until we’ve had 30 days to resolve the issue.

If you follow these guidelines when reporting an issue to us, we commit to:

* Not pursue or support any legal action related to your findings.

* Work with you to understand and resolve the issue quickly
(including an initial confirmation of your report within 72 hours of submission).

* Grant a monetary reward based on the OWASP risk assessment methodology.
