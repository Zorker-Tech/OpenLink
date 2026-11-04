# Box exec daemon process

## Startup and readiness

The host refuses startup when the loopback port is already occupied, verifies the daemon entry and creates its workspace/terminal directories before spawning. The child receives an explicit working directory and Slate environment values. Startup succeeds only after an authenticated ping answers before the deadline; an early child exit or readiness timeout fails the launch.

## Lifetime and shutdown

The host owns the child and its output forwarding. `close()` is idempotent: it sends SIGTERM, waits for exit within the configured grace, then escalates to SIGKILL and reports that forced shutdown was needed. A successful stop also verifies the port is no longer accepting connections.

## Verification

`tests/packages/host-runtime-box-process.test.ts` pins path resolution, occupied-port refusal, child environment, readiness, output, shutdown and port release with an injected process/RPC boundary.
