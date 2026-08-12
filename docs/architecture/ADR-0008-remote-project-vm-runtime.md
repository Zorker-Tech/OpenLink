# ADR-0008: Remote Project VM owns the OpenSandbox control plane

## Status

Accepted

## Context

The remote SSH target is a Linux host, not the execution boundary requested by
the product. SSH authenticates and transports commands; it does not isolate
projects from one another. A Project must therefore own a long-lived Linux VM,
while each Chat Session remains an ephemeral OpenSandbox workload inside that
VM.

The OpenSandbox server, Browser Host, and their supporting images are several
long-lived services. They need a repeatable lifecycle inside each Project VM.
The repository's Podman engine is the service control plane. Docker Compose is
neither a runtime dependency nor a VM or security boundary; it is not part of
the OpenLink deployment path.

## Decision

The remote topology is:

```text
Web Agent Host
    │ SSH / RPC tunnel
    ▼
Remote Linux host (KVM/QEMU or libvirt)
    ├── Project VM: Draft
    │     ├── OpenSandbox server
    │     ├── Browser Host
    │     └── Session sandboxes (one per chat session)
    └── Project VM: <project-id>
          ├── OpenSandbox server
          ├── Browser Host
          └── Session sandboxes (one per chat session)
```

The Project runtime starts OpenSandbox and Browser Host with direct Podman
commands inside the guest. Docker Compose is not shipped or invoked by the
remote Project=VM profile. The remote host's existing containers must never be
mounted into a Project VM.

The VM driver owns VM creation, boot, stop, deletion, workspace disk, and guest
toolchain bootstrap. The in-VM service driver owns OpenSandbox/Browser Host
processes. The session driver owns only the session sandbox and its storage.

There is no host-level Compose fallback. If QEMU/KVM, the guest image, the
repository-built Podman engine, or the guest Podman socket cannot be prepared,
Project provisioning fails explicitly and no session is started.

## Consequences

### Positive

- A project has a durable kernel, filesystem, process namespace, and toolchain.
- OpenSandbox can still provide cheap per-session cleanup and capability
  isolation inside the project VM.
- Remote host workloads unrelated to OpenLink remain outside the project VM.

### Negative

- KVM/QEMU (or libvirt) and a versioned guest image are required on the remote
  host.
- Each project consumes VM resources; idle-stop and quotas are required.
- Service endpoint tunnels must be scoped to the owning Project VM.

## Alternatives considered

### Host-level Docker/Compose

Rejected as the final architecture. It shares one container runtime and one
kernel across projects and therefore cannot represent Project=VM.

### One OpenSandbox container per project

Rejected. A container is the session/service workload boundary, not a durable
project VM with its own kernel and toolchain lifecycle.

### Kubernetes Kata runtime without a Project VM

Useful for stronger session isolation, but it still does not provide the
requested durable Project-owned workspace and service boundary. It may be used
inside a Project VM later, not as a replacement for it.

## Failure handling

- If KVM/QEMU or the guest image is unavailable, Project provisioning fails
  before any session sandbox is created.
- If in-VM OpenSandbox or Browser Host is unhealthy, the Project runtime is
  not ready and the request is retryable.
- Stopping a Project VM preserves its disk and session records; deleting a
  Project explicitly removes the VM and all VM-local artifacts.
