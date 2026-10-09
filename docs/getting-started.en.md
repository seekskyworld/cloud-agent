# Run a task and add a package

Use Node.js 24 LTS, pnpm 10.6.1 and Docker Compose v2. Run from a Cloud Agent source checkout. No external model, mailbox or business service is needed.

## Run locally

```sh
node scripts/init-env.mjs
docker compose up -d --build --wait
```

Skip initialization if `.env` already exists; it is never overwritten. Open <http://localhost:3100>, create a report, supply the missing title, and download the result. Refresh to confirm the task is persisted. Stop with `docker compose stop`, keeping the data volume.

Local mode shares one identity. Before multi-user deployment, configure authentication and access controls as described in the operations guide.

## Add a neutral package

Use the isolated [development environment](development.md#本地热更新), then run:

```sh
pnpm install --frozen-lockfile
pnpm package:create greeting
pnpm exec tsx --conditions=development --test modules/greeting-package/contract.test.ts
```

The generator creates source, a manifest test and a README, and registers the package in `modules/packages.ts`. Add the following to the development `.env` and restart API and Worker:

```dotenv
BUSINESS_PACKAGES='[{"id":"greeting","config":{"prefix":"Hello"},"bindings":{}}]'
```

Run `pnpm doctor`, then explicitly grant `greeting:run`. A superadmin can edit ordinary members in the permissions page. The default `owner` is a protected superadmin: update it using the [trusted configuration command](administration.md#可信配置) against the development database. Read the current capabilities from `GET /v1/me`, append `greeting:run`, and pass the complete list; `--capabilities` replaces the entire set.

Select greeting in the workbench and submit text; expect a result beginning with `Hello`. Roles do not automatically grant new business capabilities.

`next(input, steps)` stays pure. External calls belong to tools declaring a schema, capability, effect and recovery behavior. Register storage or provider implementations through typed host ports. Cancellation does not undo remote writes; unknown outcomes require reconciliation.

## Add a tool and verify recovery

The [executable tool tutorial](getting-started.md#添加工具并验证重启恢复) replaces the generated package with a schema-validated read tool and an approval step. Only the package source, configuration and permissions change; the Worker stays unchanged. The example upgrades the module to 1.1.0; retain older module versions while their tasks remain active.

Submit a task, stop the development Worker while approval is pending, restart it, then approve in the workbench. Expect `{"text":"Hello Cloud Agent"}` and a persisted result after another restart. `tests/tutorial.test.ts` extracts the documented code and checks authorization, approval, restart, rejection and idempotent replay against isolated PostgreSQL.

A second integration pattern is `tests/fixtures/pipeline-package.ts`: authorized connection → model → file. Both are controlled integration tests, not evidence of external production adoption. See the [integration acceptance guide](development.md#分发与验收范围) (Chinese).

## Install the standalone SDK

From the source checkout:

```sh
pnpm sdk:build
npm pack ./dist/sdk-package --pack-destination ./dist
pnpm sdk:verify
```

In an independent project install the generated tarball with `npm install <tarball-path>`. Use `@cloud-agent/sdk`, `@cloud-agent/sdk/client` and `@cloud-agent/sdk/ui`; see the [SDK README](../packages/sdk/README.md). Declare direct dependencies such as zod and React in your own package when importing them. No public npm release is assumed.

`pnpm sdk:verify` performs a fresh npm installation in a temporary directory, compiles and runs neutral contract and UI consumers, and removes that directory. It needs registry network access and never links the host's node_modules. The compiled package must still be statically registered by a trusted Cloud Agent host; installing the SDK alone does not start a service.

For reproducible source/SDK candidates, checksums and maintenance boundaries, see [development](development.md#候选交付包), [support](../SUPPORT.md) and the [documentation index](README.en.md).
