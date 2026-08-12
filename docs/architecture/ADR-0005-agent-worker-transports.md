# ADR-0005: Separate Agent API from execution transports

## Status

Accepted

## Context

OpenLink runs the same agent from a web service, a desktop application, and an SSH-connected host. These surfaces have different trust boundaries. The web server must not use the desktop OS sandbox, a remote Docker socket must never be public, and model credentials must not be copied into an agent-readable environment.

Pi exposes both an in-process Node.js SDK and a CLI RPC mode. RPC is not a second agent runtime: `rpc-entry.js` is the direct entry to the CLI's `--mode rpc` JSONL stdin/stdout transport.

## Decision

Use one OpenLink Agent API with three explicit transports:

1. Web local/service execution uses OpenSandbox and `agent-worker`, which embeds Pi through `createAgentSession` from the Node.js SDK.
2. Desktop execution uses sandbox-runtime to wrap the same Node.js SDK `agent-worker`. Credentials are masked and injected only for allowed TLS hosts.
3. Web remote execution uses strict-host-key SSH to a loopback-only OpenSandbox control plane. The sandbox runs `agent-rpc-worker`, which owns a long-lived `rpc-entry.js` process and exposes its LF-delimited JSONL stream over authenticated HTTP through OpenSandbox's server proxy. A target-specific, SHA-256 verified release archive carries pinned OpenSandbox and RPC Worker OCI images; runtime secrets are transferred separately with mode 0600.

Agent Host owns authentication, concurrency, streaming, lifecycle, and cleanup. OpenSandbox owns workload, filesystem, resource, egress, and Credential Vault isolation. SSH owns target authentication and transport only.

Both Workers consume Pi packages built from the vendored `services/pi` source.
`scripts/sync-pi-runtime.mjs` invokes Pi's upstream release pipeline, records the
declared upstream source revision and SHA-256 digests, and supplies the resulting tarballs to
local and remote Docker builds. The remote release manifest binds the RPC image
to that Pi commit and runtime-manifest digest. Registry copies of Pi are not
used at runtime.

## Consequences

### Positive

- The browser never receives a Docker socket, SSH credential, model credential, or worker capability.
- Web and desktop use their intended isolation technology.
- Node SDK and CLI RPC behavior remain independent behind one NDJSON boundary.
- One SSH tunnel carries OpenSandbox control traffic and proxied worker traffic.

### Negative

- Two worker images must be built and versioned.
- Remote deployment builds and transfers four Linux OCI images and therefore has a larger release artifact than the desktop profile.
- Desktop sandbox-runtime is process-local; concurrent sessions require separate supervisors.

### Neutral

- Pi, OpenSandbox, and sandbox-runtime remain vendored service trees in the
  root monorepo; their upstream source revisions are recorded explicitly.
- Pi runtime archives are generated build artifacts and must be synchronized
  before Worker installation or image construction.

## Failure modes

- OpenSandbox unavailable: fail before issuing a worker capability.
- Worker readiness timeout: kill the sandbox/process.
- SSH tunnel loss: abort streams; Agent Host owns eventual cleanup through its
  session reaper while OpenSandbox workloads use explicit lifetimes.
- Invalid RPC JSONL: terminate the RPC worker and never forward partial JSON.
- Credential or egress denial: surface the error without weakening policy.
- Host parent proxy unavailable during desktop TLS credential injection: fail the request; never expose the real model credential to the Worker.
- Client disconnect: abort the current prompt and retain/reap by idle TTL. If
  an older or externally expired workload handle is encountered, the next
  prompt rebuilds it from the Cloud Pi session snapshot before streaming.
- An open chat page refreshes a lease for an existing runtime without
  provisioning a sandbox. Browser Host WebSocket pings refresh the browser
  session lease; closing the page stops both heartbeats and lets idle cleanup
  reclaim resources.

## Alternatives considered

- Pi directly in Next.js: rejected because it collapses security boundaries.
- sandbox-runtime for web: rejected because it is a desktop OS process sandbox.
- Public remote OpenSandbox: rejected because it controls Docker-backed execution.
- RPC as a replacement for Pi CLI: rejected because RPC is the CLI's headless mode.

## References

- `services/agent-worker`
- `services/agent-rpc-worker`
- `services/agent-host/src/backends/local-opensandbox.ts`
- `services/agent-host/src/backends/local-sandbox-runtime-sdk.ts`
- `services/agent-host/src/backends/remote-opensandbox.ts`
