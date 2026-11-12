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

OpenLink runs this host as a supervised, loopback-only service and treats it as the Bot control
plane: agent profiles, avatars, transcripts, run scheduling, automations, groups and Bot recovery.
The application database keeps a workspace-scoped `openlink.bots` projection; each row maps one Bot
to one Work-host agent and one stable Bot runtime key (`bot-<botId>`). The key is opaque and is not a
chat session.

Bot execution uses the shared substrate without sharing the Code control plane. Work-host asks the
substrate for exactly one OpenSandbox per Bot key inside the Ubuntu Project VM, runs turns through
the shared Pi worker inside that sandbox, and owns the Bot's run queue, transcript settlement,
automations and group orchestration. It never calls the Code session lease, the Code prompt stream,
the Code event handler or the Code idle reaper.

The bridge uses these additive gateway commands:

- `ensureBotBox` / `getBotBoxStatus` / `releaseBotBox` provision, read and release the Bot's
  sandbox and desktop. The substrate token is separate from the Code control-plane token.
- `POST /api/bot/sendPrompt` durably accepts a Bot turn and streams only that Bot's transcript,
  outline and turn-lifecycle frames. A client disconnect stops the projection, not the turn.
- `respondBotExtensionUi` answers a Pi dialog that is waiting inside the Bot worker.
- `createBackgroundAgent` creates a non-kickstarted agent with the Bot's profile and avatar inputs.

- `createBackgroundAgent` creates a non-kickstarted agent with the Bot's profile and avatar inputs.
- `appendAgentTranscriptEntries` mirrors durable Bot timeline entries into the agent store. It accepts
  at most 500 entries per request and is idempotent by entry id (`INSERT OR IGNORE`).
- `replaceAgentTranscriptEntries` atomically replaces the stored timeline in one SQLite transaction.
  It accepts at most 10,000 entries per request and clears stale entries before inserting the snapshot.
- `getAgentTranscript` / `setAgentAvatarBytes` / `getAgentAvatar` read and update the projection.

`node ../../scripts/build-work-host.mjs` builds `dist/host.mjs`; `npm run smoke:openlink` boots an
isolated host and verifies health, agent creation, transcript append/replace/read and avatar bytes.
`npm run smoke:openlink:bot` boots the host against a fake substrate and a fake Pi worker, then
drives a single Bot turn, a group turn, transcript streaming and release through the real gateway.

### Transcript recovery

Work-host is the Bot transcript authority. Its data root is included in the self-hosted
backup/restore set, so a lost local store is restored from that backup rather than rebuilt from a
second authority.

A Bot that predates this control plane may still have a legacy Code-mode event log. That log is
migration input only: the BFF reads it once when the Work-host transcript has no migration marker,
appends the missing entries idempotently, re-reads the Work-host authority, and records a completion
marker. An interrupted migration resumes on the next read. A new Bot never creates a Code session
and never depends on that log.

## Build from the Slate workspace

```sh
pnpm --filter @slate/work-host build
```

The distributable contains compiled JavaScript, declaration files, SDK documentation, and its
license. Local-only reference material and tests are excluded.
