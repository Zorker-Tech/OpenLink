# Local-exec daemon entry

## Startup

The daemon holds one referenced keepalive until shutdown or startup failure. It installs invariant and crash handlers before starting the daemon. Optional executor bindings are preserved; a production executor is created only when none was supplied.

The standalone entry is bound to its real executable path and a matching generation token from both the environment and argument list. A mismatch fails closed, reports a fatal error when reporting is available, flushes within the bounded window, then exits with failure.

## Shutdown

SIGTERM or SIGINT arriving during startup is queued, with the first signal winning. Once the daemon is ready, exactly one close runs under the shutdown deadline; the keepalive is released and the process exits after that close settles.

## Verification

`tests/packages/local-exec-main.test.ts` pins keepalive, executor composition, signal ordering, startup failure, fatal crash reporting and entry identity. The process smoke also starts and stops the real box-exec and local-exec daemons.
