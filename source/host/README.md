# Host

The platform itself: persistent agents and everything they do.

| Module | Responsibility |
| --- | --- |
| `agents` | Agent profile, roster, identity, clone, delete, lifecycle |
| `transcript` | Transcript page/window/tail/outline, run queue, delivery acknowledgement, mirror |
| `runner` | Long-running runner, revival, wake, crash recovery |
| `automations` | Timer and event triggers, enablement, run-now, relay, spend gate |
| `workflows` | Durable multi-step definitions, validation, checkpoint, resume |
| `groups` / `rooms` | Fan-out, membership, invite/join, presence, room events |
| `channels` / `connectors` | External channel listeners and retry-safe delivery |
| `boxes` / `local-exec` | Box/VM/VNC/browser lifecycle and the local exec contract |
| `cloud-agents` | Remote agent launch, watch, reply, cancel, artifacts |
| `attachments` / `memory` / `skills` | Media transfer, per-agent memory, skill catalogue |
| `mcp` / `settings` / `auth` | Routed MCP and OAuth, host settings, account and presence |
| `notifications` / `telemetry` | Trays, reminders, revivals, diagnostics |
| `extensions` | Explicit extension registry — behaviour registers here, it is not patched in |
| `ports` | Typed boundaries for box, transport, telemetry, product analytics, user computer |

State ownership rule: agents, transcripts, automations, workflows, rooms, boxes and gateway
lifecycle are persisted here. Nothing in this layer may be expressed as an option on a chat
session.
