# @slate/work-host

Slate Work is a Node.js SDK for the Work platform: persistent agents, transcripts, runs, automations,
workflows, rooms, channels, execution boxes and a typed HTTP/SSE client. The package is ESM-only and
requires Node.js 24.14 or later.

## Install

Configure the internal consumer registry and install version `0.0.1`:

```sh
npm config set @slate:registry http://192.168.3.5:8081/repository/npm-public/
npm install @slate/work-host@0.0.1
```

The Work domain and protocol packages are bundled with this SDK. Applications install one package.

## Use the client

The root entry exports `createWorkClient`, route IDs and request/response types, error classes, and
the Work domain models:

```ts
import { createWorkClient } from "@slate/work-host"

const work = createWorkClient({
  baseUrl: "http://127.0.0.1:4318",
  headers: { authorization: `Bearer ${process.env.WORK_TOKEN}` },
})

const agents = await work.request("work.agent.list")
```

## Run the host

The `@slate/work-host/host` entry provides the production composition and lifecycle:

```ts
import { createProductionHostPorts, startProductionHost } from "@slate/work-host/host"

await startProductionHost(createProductionHostPorts())
```

The host is a long-running Node process. It reads its configuration from environment variables,
owns persistent Work state, and installs process shutdown handlers. Use `@slate/work-host/gateway`
to compose an HTTP/SSE gateway directly, or `@slate/work-host/box-exec` to run the isolated box
execution daemon. Entrypoint type declarations are included in the package.

Work modules continue to land with their behavior tests; consult the exported route contracts and
current host implementation when selecting capabilities for an application.

## Build from the Slate workspace

```sh
pnpm --filter @slate/work-host build
```

The distributable contains compiled JavaScript, declaration files, SDK documentation, and its
license. Local-only reference material and tests are excluded.
