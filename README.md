# @slate/work-host

The **Work platform**: persistent agents and everything they do — transcripts, runs, automations,
workflows, groups, rooms, channels, boxes and cloud agents.

It ships with the desktop app. That is deliberate: Work mode *is* the desktop product's main body,
and the platform runs in the app's Node runtime next to the renderer, which is also how the
reference implementation is packaged (one repository containing the Electron shell, the host, the
coordinator and the two daemons).

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
```

Rules:

- the gateway is an entry point only — it resolves a command, checks scope, delegates; it holds no
  product logic and never accepts an arbitrary command string;
- the host owns state: agents, transcripts, runs, automations, workflows, rooms, boxes and gateway
  lifecycle are persisted here;
- local-exec and box-exec are separate processes with their own lifecycle, identity and readiness
  records — they must not degrade into functions inside the host;
- scheduled work belongs here, not in the renderer: persistent agents have to outlive the client.

See [work-backend.md](../../docs/architecture/work-backend.md) for the architecture,
[work-routes.md](../../docs/api/work-routes.md) for the 83-route contract, and
[ADR 0003](../../docs/adr/0003-work-platform-lives-with-the-desktop.md) for why this lives here.
