# OpenLink Agent Execution Boundaries

## Goal

Run the Pi agent in a controlled execution environment for both OpenLink web
sessions on remote SSH targets and desktop sessions on the local machine, while
keeping sandbox lifecycle, credentials, storage, and transport outside the
Next.js request process.

## Requirements

### Functional

- Select a local desktop or remote SSH execution target per session.
- Provision an isolated workspace and persistent session/artifact storage.
- Run Pi in RPC mode so the UI receives streaming events through one contract.
- Use OpenSandbox for remote Docker/Kubernetes-capable execution.
- Use Anthropic sandbox-runtime for local OS-level process restrictions.
- Stop, expire, and clean up environments without losing session metadata.

### Non-functional

- The Next.js app never executes Pi tools, SSH commands, or sandbox processes.
- User/API credentials never appear in command arguments, logs, or session JSONL.
- Remote control planes bind to loopback and are reached through an authenticated
  SSH tunnel or a mutually authenticated private network.
- Each session receives a dedicated workspace and policy; no host-wide mounts.
- Backends are replaceable without changing the UI or session schema.

## Architecture

```text
Web/Desktop UI
      │ authenticated OpenLink API / IPC
      ▼
OpenLink control plane (Next.js + Supabase metadata)
      │ AgentExecutionRequest
      ▼
services/agent-host (independent Node service)
      ├── LocalBackend ── sandbox-runtime ── Pi RPC child
      └── RemoteBackend ─ SSH ─ OpenSandbox server ─ sandbox ─ Pi RPC
                                                │
                                workspace + Pi JSONL + artifacts
```

OpenLink stores only identity, workspace, session index, policy version, and
audit metadata in Supabase. Session JSONL, workspace files, and generated
artifacts remain on the execution node unless a deliberate export is requested.

## Components

- `services/pi`: vendored upstream Pi source and its own npm workspace.
- `services/opensandbox`: vendored upstream OpenSandbox source. The remote target
  runs its server/control plane; the host service uses its SDK/API.
- `services/sandbox-runtime`: vendored local OS sandbox source. The desktop host
  wraps Pi's child process with `SandboxManager.wrapWithSandboxArgv()`.
- `services/agent-host`: OpenLink-owned contracts, policy compiler, backend
  selection, Pi RPC runner, SSH bootstrap plan, and storage layout.

## Remote flow

1. Authenticate the user and authorize the workspace/target in OpenLink.
2. Validate an SSH target record without accepting shell fragments.
3. Preflight the target: OS, architecture, Docker/runtime availability, disk,
   free ports, and supported OpenSandbox release.
4. Upload a versioned, checksum-verified release bundle containing Pi and the
   OpenSandbox deployment assets; never run `curl | sh`.
5. Start OpenSandbox bound to remote loopback, then establish an SSH tunnel.
6. Create one sandbox with explicit mounts, egress allowlist, resource limits,
   and a persistent session volume.
7. Start Pi RPC in the sandbox and relay JSONL events through the host service.

The remote bootstrap is a plan/executor boundary. The first implementation can
generate and audit a plan; actual remote execution must require an explicit
target approval and a host-specific SSH implementation.

## Local flow

1. Resolve a desktop workspace directory and create a per-session storage root.
2. Compile the policy into sandbox-runtime's filesystem/network configuration.
3. Initialize `SandboxManager` once for the host session.
4. Wrap the Pi RPC argv and spawn it with an allowlisted environment.
5. Relay stdin/stdout JSONL and persist only sanitized session events locally.
6. Reset sandbox-runtime and terminate the child on session stop/expiry.

## Security boundary

The agent host owns the only privileged operations. It must enforce:

- path containment for workspace, storage, and mounted paths;
- an allow-only write policy and deny rules for `.env`, SSH keys, cloud config,
  credential stores, and repository metadata as configured;
- an allow-only network policy with per-domain/port rules;
- bounded command, output, frame, CPU, memory, disk, and wall-clock limits;
- environment-variable allowlists and secret injection through a credential
  broker, never through argv or prompt text;
- structured audit events with secret redaction.

OpenSandbox's server API key and remote SSH credentials are control-plane
secrets. They are not passed into Pi's model context. sandbox-runtime's
credential masking features are enabled only for explicitly approved domains.

## Failure handling

| Failure | Behavior |
|---|---|
| SSH unavailable | Mark execution target offline; do not retry unsafe commands |
| Bootstrap checksum mismatch | Abort and retain target untouched |
| Sandbox creation timeout | Destroy partial sandbox and record diagnostic |
| Pi process exits | Preserve session/artifacts, mark runtime exited |
| Control-plane disconnect | Keep remote session lease until TTL, then clean up |
| Storage full | Stop new writes, emit audit event, retain metadata |

## Alternatives

- Running Pi directly inside Next.js: rejected because it grants server request
  handlers agent-level process/filesystem authority.
- Using sandbox-runtime for remote Linux: rejected because it is host-level OS
  sandboxing, not a remote Docker/Kubernetes control plane.
- Using OpenSandbox for desktop: rejected for the first phase because it needs
  Docker/runtime services and adds a local control plane where OS-level process
  isolation is sufficient.
