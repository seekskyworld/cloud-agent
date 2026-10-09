# Documentation

Cloud Agent is a reusable engineering framework for business AI agents. Build the rules and integrations that differ between applications; reuse task execution, approvals, recovery and audit. [简体中文](README.md).

Start with [why Cloud Agent](../README.md#why-cloud-agent), then follow the [English quick start](getting-started.en.md) to run a task and add your own package. Node.js 24 LTS, pnpm 10.6.1 and PostgreSQL 17 are the supported baseline. Local mode requires no token or model key.

| Goal                                                     | Guide                                                                                                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Run and build a first package                            | [Getting started](getting-started.en.md)                                                                                              |
| Understand layers, task execution and generic boundaries | [Architecture](cloud-agent-architecture.md) (Chinese)                                                                                 |
| Reuse framework services for a business application      | [Business reuse](business-reuse.md) → [modules](modules.md) → [extensions](extending.md) (Chinese)                                    |
| Consume the standalone SDK                               | [SDK README](../packages/sdk/README.md)                                                                                               |
| Replace models, storage, credentials or channels         | [Extensions](extending.md), [external packages and upgrades](external-extensions.md), [model lifecycle](model-lifecycle.md) (Chinese) |
| Connect mailboxes or add mail providers                  | [Mail architecture](mail-architecture.md), [configuration](operations.md#可选邮件通道) (Chinese)                                      |
| Use APIs and manage access                               | [API reference](api.md), [permissions](administration.md) (Chinese)                                                                   |
| Develop, test and prepare artifacts                      | [Development](development.md), [Agent guide](../AGENTS.md) (Chinese)                                                                  |
| Deploy, upgrade and recover                              | [Operations](operations.md), [support](../SUPPORT.md) (Chinese)                                                                       |

The protocol and operator references currently use Chinese; this index does not imply complete translation. Only neutral examples are bundled. Domain rules, data models and service-specific integrations belong in independently maintained packages and adapters. Production code must not import test fixtures or local reference repositories. Implementation, automated verification and real-provider validation are separate milestones; see the [verification guide](development.md#分发与验收范围).

Contributing and maintenance: [contributing](../CONTRIBUTING.md), [governance](../GOVERNANCE.md), [changelog](../CHANGELOG.md), [security](../SECURITY.md).
