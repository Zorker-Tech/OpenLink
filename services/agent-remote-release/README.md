# OpenLink remote Agent release

This directory is the immutable template for an SSH-deployed OpenSandbox
control plane. The release builder produces a checksummed archive containing:

- the OpenSandbox server, execd, and egress images pinned to the checked-out
  OpenSandbox submodule;
- the OpenLink Pi CLI RPC Worker image;
- a loopback-only Docker Compose control plane and its rendered TOML config.

`release.json` records both upstream submodule commits, the bundle checksum,
and the SHA-256 digest of the pinned Pi runtime manifest used by the RPC image.

Runtime secrets are never included in the archive. `remote-main.ts` writes a
mode-0600 temporary `runtime.env`, uploads it over strict-host-key SSH, and the
bootstrap plan protects it before starting Compose.

Build a Linux/amd64 release for a writable remote root:

```bash
node scripts/build-agent-remote-bundle.mjs \
  --release-id 2026-08-06.1 \
  --remote-root /home/openlink/.openlink-agent \
  --platform linux/amd64
```
