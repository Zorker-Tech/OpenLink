# ADR-0002: Keep Agent Runtimes as Independent Services

- Status: Accepted
- Date: 2026-08-05
- Decision owners: OpenLink engineering

## Context

OpenLink is a Next.js application using pnpm. Pi is an upstream TypeScript
agent monorepo using npm workspaces and requiring Node `>=22.19.0`; it includes
local shell, filesystem, process, provider, and session capabilities. OpenSandbox
is a Python/Docker/Kubernetes sandbox platform, while Anthropic's sandbox-runtime
is a Node/OS-level sandbox for local processes. These projects have separate
lockfiles and deployment prerequisites.

The user wants these capabilities available to OpenLink while keeping agent
execution independent from the web service and allowing the Node runtime to
change later.

## Decision

Vendor each upstream repository into `services/` with `git subtree`, preserving
its complete history while keeping it outside the root package workspace:

- `services/pi` — agent runtime and CLI/RPC/SDK.
- `services/opensandbox` — remote sandbox platform.
- `services/sandbox-runtime` — local desktop OS sandbox.
- `services/code-server` — project-scoped VS Code web runtime.

Keep each upstream workspace, lockfile, scripts, and runtime requirements inside
its directory. Exclude `services/**` from the OpenLink TypeScript project so the
Next.js build cannot accidentally compile or bundle service source.

The OpenLink application does not import Pi directly and does not merge Pi's
dependencies into the root `package.json` or `pnpm-lock.yaml`. The separate
`services/agent-host` boundary communicates with Pi over an explicit protocol
such as RPC/JSONL or an internal transport.

## Directory shape

```text
services/
├── README.md
├── agent-host/             # OpenLink-owned adapter/supervisor contracts
├── pi/                     # subtree-imported agent runtime source
├── opensandbox/            # subtree-imported remote sandbox source
├── sandbox-runtime/        # subtree-imported desktop sandbox source
└── code-server/            # vendored VS Code web runtime source
```

## Alternatives considered

1. Root `packages/*` workspace packages — rejected because they mix npm/pnpm
   lockfiles, couple Node/Python runtimes, and expose privileged code to the
   Next.js build graph.
2. Copying source into `lib/agents` — rejected because upstream updates and
   license/source attribution become difficult to track.
3. Installing only published SDK packages — rejected for this step because the
   requested source checkouts and future runtime changes need pinned trees.

## Consequences

### Positive

- Each runtime can evolve its language/runtime and dependencies independently.
- `services/source-revisions.json` records the exact upstream source revision
  represented by each imported service.
- OpenLink's browser bundle and pnpm lockfile remain unaffected.
- Security boundaries can be designed at the service process boundary.

### Trade-offs

- Cloning the root repository checks out the service sources directly; no
  nested repository initialization or network access is required.
- Each runtime must be installed and built separately in deployments.
- Production process supervision, credential brokering, and transport adapters
  are still required before exposing execution to untrusted user prompts.
