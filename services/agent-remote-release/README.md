# OpenLink remote Agent release

This directory is the immutable template for an SSH-deployed Project VM
runtime. The SSH target is only a Linux/KVM host; the bundle is installed into
the Project VM created on that host. The release builder produces a checksummed
archive containing:

- the OpenSandbox server, execd, and egress images built from the vendored
  OpenSandbox source;
- the OpenLink Pi CLI RPC Worker image;
- the Podman engine built from `services/linux` for the target Linux
  architecture;
- the Project VM helper used to create and control QEMU guests.

`release.json` records both upstream source revisions, the bundle checksum,
the SHA-256 digest of the pinned Pi runtime manifest used by the RPC image, and
the digest of the repository-built Podman engine.

Runtime secrets are never included in the archive. `remote-main.ts` uploads only
the immutable bundle over strict-host-key SSH. Project-scoped credentials are
generated and persisted by the Agent Host, then mounted into the corresponding
VM service containers.

The remote profile provisions KVM/QEMU on the Linux host, starts one VM per
Project, installs the repository-built Podman engine and automatically
provisions its runtime support packages inside the guest. OpenSandbox,
Browser Host, Pi workers, and all Session sandboxes are started through Podman
inside the selected VM. The remote host's unrelated containers are never used
as a Project runtime, and Docker Compose is not part of the runtime path.

Build a Linux/amd64 release for a writable remote root:

```bash
node scripts/build-agent-remote-bundle.mjs \
  --release-id 2026-08-06.1 \
  --remote-root /home/openlink/.openlink-agent \
  --platform linux/amd64
```
