# @cloud-agent/sdk

Build business packages that reuse Cloud Agent task execution, approvals and recovery. This SDK exposes versioned TypeScript contracts for your modules, tools, integrations and static UI contributions; the Cloud Agent host supplies the runtime.

Apache-2.0; see LICENSE and NOTICE included in this package. Node.js 24 LTS is the supported baseline.

The SDK is delivered as a tarball built from the matching Cloud Agent source revision. No npm registry release is currently promised:

```sh
npm install ./cloud-agent-sdk-0.3.0-preview.1.tgz
```

Public entry points:

- `@cloud-agent/sdk`: `defineBusinessPackage`, `definePort`, Module, Tool, Action and supporting contracts.
- `@cloud-agent/sdk/client`: `CloudAgentClient` for the HTTP v1 API.
- `@cloud-agent/sdk/connectors`: public mail, channel, artifact store, model and context contracts.
- `@cloud-agent/sdk/testing`: explicit mail contract checks for isolated fixtures.
- `@cloud-agent/sdk/ui`: static module and page contracts; UI consumers explicitly install React 19 and its types.

A minimal package uses only the public SDK:

```ts
import { z } from "zod";
import { defineBusinessPackage } from "@cloud-agent/sdk";

export const greeting = defineBusinessPackage({
  id: "greeting",
  version: "1.0.0",
  sdkMajor: 1,
  permissions: ["greeting:run"],
  config: z.object({}).strict(),
  requires: {},
  create: () => ({
    modules: [
      {
        id: "greeting",
        version: "1.0.0",
        title: "Greeting",
        description: "Neutral example",
        capability: "greeting:run",
        input: z.object({ text: z.string() }),
        example: { text: "Hello" },
        tools: [],
        runtime: { model: false },
        next: (input) => ({
          kind: "complete",
          result: { text: String(input.text) },
        }),
      },
    ],
  }),
});
```

Install `zod` as a direct dependency when your package imports it. Register the package in the host's trusted static manifest, enable it through `BUSINESS_PACKAGES`, and explicitly grant its capability to existing identities. The SDK alone does not start a server or execute tasks.

SDK major 1 is the current protocol. Module versions and dependency fingerprints govern task recovery; changing execution semantics requires a module version change. Do not import internal package paths. Modules are trusted deployed code, not sandboxed user scripts. Pure `next` functions must not perform IO; side effects belong to tools with explicit authorization, idempotency and recovery semantics.

From a source checkout, see `docs/getting-started.md`, `docs/extending.md` and `docs/development.md`. These guides are shipped in the source archive, not duplicated inside the SDK.
