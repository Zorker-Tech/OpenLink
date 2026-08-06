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
