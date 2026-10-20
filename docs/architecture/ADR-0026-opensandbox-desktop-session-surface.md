# ADR-0026: Put the desktop surface inside each OpenSandbox session

## Status

Accepted

## Context

Each Project maps to one durable Linux VM. Agent Host provisions a separate
OpenSandbox workload for each chat session and mounts the Project workspace at
`/workspace` plus that chat's durable files at `/openlink/session`. Users need
a desktop without changing the Project VM boundary or combining session
workloads.

The desktop has two runtime modes. The default `ubuntu-container` mode runs an
Ubuntu GNOME userspace in the session workload and works without KVM. The
opt-in `ubuntu-iso` mode boots the official Ubuntu Desktop ISO in a QEMU/KVM
guest inside that same workload. Each chat session stores its own qcow2 disk in
its session volume. The guest mounts the Project workspace through 9p, so it
sees the same files as the Agent Worker.

Select ISO mode with `OPENLINK_DESKTOP_MODE=ubuntu-iso`; the Agent Host stages
the verified ISO from `OPENLINK_UBUNTU_DESKTOP_ISO` (or its default runtime
cache path). ISO mode is used only for QEMU/KVM Project VMs. Local rootless
Podman projects continue to use the container fallback.

OpenSandbox's desktop example uses Xvfb, VNC, websockify, and noVNC assets. A
browser cannot send the OpenSandbox API key required by a multi-tenant proxy,
so the desktop port needs a trusted gateway that injects the internal endpoint
credentials.

## Decision

- Install Ubuntu GNOME, Xvfb, VNC, websockify, and the QEMU utilities in both
  OpenLink Agent Worker images. Keep `ubuntu-container` as the default fallback.
- In `ubuntu-iso` mode, require a verified Ubuntu Desktop ISO and a readable
  `/dev/kvm` on the OpenSandbox host. Grant that device only to workloads that
  request the `openlink.qemu-kvm` extension.
- Start the desktop through an authenticated Agent Worker endpoint. Do not
  launch QEMU through execd's bubblewrap command path, whose private `/dev`
  namespace intentionally hides host devices.
- Bind the session VNC server to sandbox port 6080 and expose it to the browser
  only through Agent Host's Desktop Gateway. The gateway injects OpenSandbox
  endpoint headers and gives the browser an expiring, per-session capability.
- Render the remote framebuffer in the application with the noVNC RFB client
  library, not a noVNC web page or iframe. Fit the canvas to the available
  pane and request matching remote desktop dimensions.
- Keep the workspace and session volume mounts. Different chat sessions keep
  separate OpenSandbox workloads and session storage while sharing the same
  Project workspace with the desktop guest.
- Keep desktop availability optional on runtimes that do not expose a desktop
  endpoint.

## Consequences

- The Ubuntu container fallback uses GNOME/Xvfb. It is not a booted Ubuntu
  Desktop installation and does not require KVM.
- `ubuntu-iso` runs the full Ubuntu Desktop operating system, but requires
  nested KVM access through a rootful Project VM. The outer host must expose
  VT-x/AMD-V to the Project VM; the VM bootstrap loads the nested KVM module
  when those CPU flags are available. Its session workloads need more CPU,
  memory, and disk than the container fallback.
- The first ISO boot runs an unattended install. The installed qcow2 disk is
  retained in that chat session's storage for later restarts.
- Opening the desktop adds GUI and VNC processes to that session workload.
  The VM mode additionally runs QEMU until the sandbox pauses or closes.
- The worker images are larger because they ship the GUI and VM packages.
- Browser clients never receive OpenSandbox API keys or direct sandbox URLs.
  Reverse proxies must allow WebSocket upgrades on the Desktop Gateway path.
- The application-owned canvas avoids the sandboxed-document `localStorage`
  error from the noVNC page and can resize the remote session with its pane.
- The desktop is a human-operated view. Browser Host remains the separate
  protocol surface for Pi browser automation and page inspection.

## References

- `docs/architecture/ADR-0007-project-vm-runtime-boundaries.md`
- `docs/architecture/ADR-0009-browser-session-gateway.md`
- `services/opensandbox/examples/desktop`
