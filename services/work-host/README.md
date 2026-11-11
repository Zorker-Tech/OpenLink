# @slate/work-host

Slate Work is a Node.js SDK for the Work platform: persistent agents, transcripts, runs, automations,
workflows, rooms, channels, execution boxes and a typed HTTP/SSE client. The package is ESM-only and
requires Node.js 22.19 or later.

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

## OpenLink Bot bridge

OpenLink runs this host as a supervised, loopback-only service and treats it as the Bot domain
authority for agent profiles, avatars and transcripts. The application database keeps a workspace
scoped `openlink.bots` projection; each row maps one Bot to one Work-host agent and one hidden
Code-mode chat session. The Code-mode Agent Host remains the execution authority: Pi runs in a
per-session OpenSandbox inside the Ubuntu Project VM, and the same chat session owns the desktop.

The bridge uses four additive gateway commands:

- `createBackgroundAgent` creates a non-kickstarted agent with the Bot's profile and avatar inputs.
- `appendAgentTranscriptEntries` mirrors durable Bot timeline entries into the agent store. It accepts
  at most 500 entries per request and is idempotent by entry id (`INSERT OR IGNORE`).
- `replaceAgentTranscriptEntries` atomically replaces the stored timeline in one SQLite transaction.
  It accepts at most 10,000 entries per request and clears stale entries before inserting the snapshot.
- `getAgentTranscript` / `setAgentAvatarBytes` / `getAgentAvatar` read and update the projection.

`node ../../scripts/build-work-host.mjs` builds `dist/host.mjs`; `npm run smoke:openlink` boots an
isolated host and verifies health, agent creation, transcript append/replace/read and avatar bytes.

### Transcript recovery

Work-host is the Bot transcript authority, while the durable Code-mode event log is the recovery
source. The BFF reconciles both on every detail read:

- A missing tail is appended in idempotent chunks of at most 500 entries.
- A gap before the newest stored entry is an ordering violation and is repaired with one atomic
  replacement.
- A required replacement above 10,000 entries is never truncated. The BFF logs the explicit limit
  error, keeps the complete durable transcript for rendering, and defers the mirror write.
- Entries that exist only in Work-host are retained, so a partial event-log loss does not erase the
  visible timeline.

## Build from the Slate workspace

```sh
pnpm --filter @slate/work-host build
```

The distributable contains compiled JavaScript, declaration files, SDK documentation, and its
license. Local-only reference material and tests are excluded.
