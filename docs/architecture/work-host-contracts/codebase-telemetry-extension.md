# Codebase telemetry extension contract

The codebase telemetry host extension depends on account authentication and feature experiments. Its public extension
surface always includes `flushPendingUploads()`.

When the `csnaps` helper is missing or cannot execute, startup logs which condition occurred, installs no transcript
listeners, registers no teardown, and returns a flush method that resolves without work. When the helper can execute,
the extension creates the telemetry service, listens for run start and run end to request snapshots, and registers
service disposal with host shutdown. Disposal removes both listeners and closes the service.

The helper stores account UUID state below the configured Slate data root and snapshots below
`/var/lib/slate/telemetry/codebase`. Snapshot uploads and privacy refresh use five-minute polling. The extension supplies
bounded privacy lookup, lookup retry, session restart, and shutdown policies; callers can flush uploads even when no
account credential has created a helper session yet.

At each upload attempt, the interop adapter obtains the current machine ID and projects the account token plus backend
headers, a machine checksum, and the explicit non-ghost mode into the helper's upload envelope. This remote envelope is
owned by the adapter boundary; host composition depends on its operation and does not assemble remote header fields.
