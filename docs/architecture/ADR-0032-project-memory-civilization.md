# ADR-0032 — Project Memory through Civilization

Status: accepted  
Date: 2026-11-06  
Related: [repository boundaries](./standards/03-repository-boundaries.md),
[data and security standards](./standards/05-data-and-security.md),
[agent runtime policy](./standards/10-agent-runtime-policy.md)

## Context

OpenLink needs durable memory for decisions, conventions, and procedures that
belong to one Project and one product Agent mode. The Knowledge service manages
workspace collections and source documents; it is not the agent's persistent
memory service.

Civilization provides the Orion memory kernel, persistence, and the Stage74
memory HTTP service as a complete upstream project. Its first formal release is
`v1.0.0` (`2594df21847bf0689fb3c362c6823a0a352afaa8`). OpenLink's repository
rules require complete upstream projects to be vendored under `services/` with
`git subtree`, preserving their history and recording the exact revision.

## Decision

Import the complete Civilization `v1.0.0` repository into `services/civilization`
with `git subtree`. Keep the upstream project, license, documentation, CLI,
service chain, and build metadata together. Do not put the vendored source
inside the Agent Host package.

Agent Host owns only the OpenLink launcher and access adapter. At startup, it
launches Civilization's actual `Stage74OrionMemoryService` as a loopback-only
Python process, creates its internal bearer token, and stores Orion's durable
journal below the Agent Host storage root. No Civilization-specific user
configuration is required.

The initial integration is for Code mode. Agent Host derives one stable,
opaque Civilization `session_id` from the Project ID and mode, so Orion memory
persists across chats in that Project while remaining separate from other
Projects and future modes. The upstream process-global store is not exposed as
cross-Project memory.

The Agent Host MCP gateway provides `project_memory_search` and
`project_memory_remember`. Search and writes are authorized for autonomous use;
the agent searches relevant memory at the start of substantive tasks and saves
concise, verified durable facts or procedures as it learns them. The tools do
not accept Project IDs, modes, or Orion session IDs from the agent. The Agent
Host validates the Project-and-mode capability and keeps the upstream token
inside the host.

OpenLink uses its existing agent runtime for model inference. Civilization's
Stage74 memory APIs remain the real upstream implementation, while decision
inference is explicitly disabled in this memory-only service instance. Four
small upstream patches defer PyTorch imports until checkpoint inspection,
model-runtime construction, or adapter encoding, allowing the Orion service to
run without installing Civilization's optional model-inference dependencies.
These patches are recorded in `services/source-revisions.json`.

The root lifecycle checks the vendored version and pin before building Agent
Host. Self-hosted release assembly copies the complete `services/civilization`
tree and checks that the launcher, license, package metadata, and Stage74 entry
point are present. This prevents a clean first build or release from silently
omitting the memory service.

## Runtime flow

```text
Code agent
   │ project-and-mode MCP capability
   ▼
Agent Host MCP ─────► upstream Stage74 Orion memory service
 Project/mode gate        loopback + internal token
                               │
                               ▼
                   durable Orion session journal
```

- The session journal is stored below
  `<Agent Host storage root>/civilization-memory/orion-memory` and is fsynced
  on each acknowledged write.
- The public MCP route is available only from the Agent Host. Project VMs and
  agent sessions never receive the upstream bearer token or connect directly
  to the service.
- The remote Agent Host exposes the same Code-mode MCP tool only when
  `OPENLINK_REMOTE_AGENT_PUBLIC_URL` points to a reachable HTTPS origin.
- T1, T2, and E1 are runtime architectures, not agent modes. A future product
  mode must receive its own explicit Agent Host binding and memory scope.

## Consequences

### Positive

- Civilization is a complete, history-preserving upstream service in the
  repository's required `services/` layout.
- Project memory persists across chats without mixing data between Projects or
  future product modes.
- The feature is built and packaged with the product lifecycle and needs no
  per-user installation or service configuration.
- The host integration adds no PyTorch, Transformers, model weights, or model
  provider credentials to the Agent Host runtime.

### Limitations

- The Agent Host launcher requires Python 3.10 or newer; self-hosted preflight
  checks for it.
- The current MCP surface exposes durable semantic and procedural memory.
  Civilization's other Orion systems and service routes remain available in
  the vendored upstream implementation but are not exposed to the agent by this
  initial adapter.
- Writes are append-oriented; safe update, delete, deduplication, and conflict
  resolution policy can be added through the upstream API as the product
  integration evolves.

## Source and operations

The exact upstream tag, commit, version, Apache-2.0 license, and OpenLink source
patches are recorded in [`services/source-revisions.json`](../../services/source-revisions.json).
Agent Host starts the upstream Stage74 service directly through
[`services/agent-host/civilization-host.py`](../../services/agent-host/civilization-host.py).
The source tree remains independently buildable and outside the root
Next.js/TypeScript graph.
