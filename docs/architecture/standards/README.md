# Architecture design standards

These documents define the current OpenLink architecture and the rules for
changing it. They are normative: “must”, “must not”, and “only” are binding
constraints.

## Reading order

1. [`01-principles.md`](./01-principles.md) — system invariants and design
   priorities.
2. [`02-system-context.md`](./02-system-context.md) — components, trust
   boundaries, and data flow.
3. [`03-repository-boundaries.md`](./03-repository-boundaries.md) — ownership of
   directories and dependency graphs.
4. [`04-runtime-lifecycle.md`](./04-runtime-lifecycle.md) — Local/Cloud startup,
   Project VM, Worker, browser, and knowledge lifecycles.
5. [`05-data-and-security.md`](./05-data-and-security.md) — identity, tenancy,
   secrets, persistence, and network policy.
6. [`06-change-governance.md`](./06-change-governance.md) — how architectural
   changes are proposed, implemented, migrated, and verified.
7. [`07-non-functional-requirements.md`](./07-non-functional-requirements.md) —
   reliability, performance, availability, security, and operability baseline.
8. [`08-release-versioning.md`](./08-release-versioning.md) — shared product
   version, T1-Crab/T2-Orion release names, and compatibility-mode versioning.
9. [`09-agent-tool-registry.md`](./09-agent-tool-registry.md) — project-scoped
   CLI tool registration, sandbox exposure and discovery.
10. [`10-agent-runtime-policy.md`](./10-agent-runtime-policy.md) — capability
    policy injection, native desktop tools and Pi/Codex parity.
11. [`11-chat-session-runs.md`](./11-chat-session-runs.md) — durable run
    status, background execution and session-bound UI state.
12. [`12-live-browser-and-preview.md`](./12-live-browser-and-preview.md) —
    Agent-owned Live Browser, full browser tool parity and multi-target
    Project preview discovery.
13. [`13-composer-capabilities.md`](./13-composer-capabilities.md) — runtime
    capability inventory for permissions, MCP, skills, instructions and
    Computer activity.

## Scope

The standards cover the OpenLink application, its owned adapter services, its
vendored runtimes, ZOKERBASE, Zero/ZeroLink, Project VMs, Browser Runtime, and
Local/Cloud deployment boundaries.

They do not restate upstream project internals. Upstream-compatible source may
retain original names and protocols where required for compatibility and
attribution. Product-facing names, runtime paths, images, variables, and
contracts use the product vocabulary defined in the standards.
