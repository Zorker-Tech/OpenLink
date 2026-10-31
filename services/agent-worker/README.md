# OpenLink Agent Worker

This process runs inside an execution boundary and embeds Pi through its
Node.js SDK. It is not started directly by the web application.

- Web/local: Agent Host creates an OpenSandbox container and starts this worker.
- Desktop: the desktop host starts the same worker through sandbox-runtime.
- Web/SSH: remote OpenSandbox may start this worker when the bundle includes
  Node dependencies, or Pi's `rpc-entry.js` when using the portable CLI bundle.

`rpc-entry.js` and `pi --mode rpc` expose the same JSONL RPC mode. The direct
entry avoids an extra CLI dispatch layer and is preferred for managed remote
bundles.

## Desktop runtime

`OPENLINK_DESKTOP_MODE=ubuntu-container` starts GNOME/Xfce under Xvfb.
`OPENLINK_DESKTOP_MODE=ubuntu-iso` boots the verified Ubuntu Desktop ISO in a
QEMU guest. In ISO mode the Agent Host mounts a project-scoped cache at
`OPENLINK_DESKTOP_CACHE_ROOT` (`/opt/openlink/desktop-cache`); the worker builds
one installed golden qcow2 there and gives every chat session a thin
copy-on-write overlay. The first session in a Project VM pays the unattended
install; later sessions and Agent Host restarts boot in seconds. The verified
ISO itself stays on a separate read-only mount.
