# @slate/work-host

> **Status: landing module by module.** The platform is implemented here in Slate's own structure and
> naming, one functional module at a time, each with behaviour tests. `source/` holds what exists so
> far; the layer READMEs describe the layers as they are built out.

The **Work platform** — **Slate Assistant** (also `slate-work` / `slate-bot`): persistent agents and everything they do — transcripts, runs, automations,
workflows, groups, rooms, channels, boxes and cloud agents.

It ships with the desktop app. That is deliberate: Work mode *is* the desktop product's main body,
and the platform runs in the app's Node runtime next to the renderer.

It is **independent of the Code agent**: different process, different repository, no shared code.
Code mode talks to the local `slate-agent` binary; Work mode talks to this platform.

```text
source/gateway       authenticated command gateway: static command catalogue, health, SSE, request id
source/coordinator   gateway client, host/local-exec supervisors, inference router, oauth, webauthn, MCP bridge
source/host          the platform itself: agents, transcript, runner, automations, workflows,
                     groups, rooms, channels, connectors, boxes, cloud-agents, attachments, memory,
                     skills, mcp, settings, auth, notifications, telemetry, extensions, ports
source/local-exec    standalone local execution daemon contract
source/box-exec      box/remote execution bridge contract
source/shared        cross-cutting types and policies
source/packages      platform libraries the layers above are built from
```

Rules:

- the gateway is an entry point only — it resolves a command, checks scope, delegates; it holds no
  product logic and never accepts an arbitrary command string;
- the host owns state: agents, transcripts, runs, automations, workflows, rooms, boxes and gateway
  lifecycle are persisted here;
- local-exec and box-exec are separate processes with their own lifecycle, identity and readiness
  records — they must not degrade into functions inside the host;
- scheduled work belongs here, not in the renderer: persistent agents have to outlive the client.

Conventions:

- relative imports carry an explicit `.ts` extension, so any module runs directly under
  `node --test` with `--experimental-transform-types` — no build step between writing a module and
  testing it;
- dependencies are declared when the module that needs them lands, not in advance;
- everything here is ours: file names, identifiers, package names and strings; no third-party
  product names, documentation links or telemetry endpoints;
- `reference/` is local-only material and is never committed;
- a file counts as *rewritten* only under the token-overlap gate: `pnpm --filter @slate/work-host rewrite:overlap check`
  refuses a claim while the file still reproduces 0.8 or more of the baseline's identifier pairs (adapters and generated
  files are exempt with a reason on the list it prints); `report` and `queue` are the risk-first order of the rewrite pass;
- the ledger has three honest books, not two: a file is *rewritten*, *at the floor* (`claim: "floor"` with its measured
  number and the reason the rest is the interface other modules import), or still waiting. `check` refuses a floor claim
  that could have been a plain rewrite, one that does not say why, and one whose recorded number is not what it measures;
- the tests need Node **24.14.0**: `node:sqlite` accepts a zero-length blob from 24.22 on, and one behaviour suite pins
  the refusal, so `node --test` on a later 24.x reports a failure the implementation does not have.

```bash
pnpm --filter @slate/work-host typecheck   # strict, NodeNext-style source layout
pnpm --filter @slate/work-host test        # behaviour tests, run straight from TypeScript
pnpm --filter @slate/work-host rewrite:overlap check   # the gate on calling a file rewritten
```

See [work-backend.md](../../docs/architecture/work-backend.md) for the architecture,
[work-routes.md](../../docs/api/work-routes.md) for the 83-route contract, and
[ADR 0003](../../docs/adr/0003-work-platform-lives-with-the-desktop.md) for why this lives here.
