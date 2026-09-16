# Gateway

The authenticated command gateway: the only entry point into the Work backend.

| Concern | Rule |
| --- | --- |
| Command surface | A static command catalogue. No dynamic command names, no passthrough to arbitrary methods. |
| Health | Readiness for host, coordinator, local-exec, box and bridges, each reported separately. |
| Events | SSE with heartbeat, cursor, and resumable reconnect. |
| Identity | Every request carries a request id, an account/agent scope, and nonce/idempotency where a mutation can be retried. |
| Errors | One envelope shape across the gateway; error detail is redacted before it leaves the process. |

The gateway does not contain product logic: it resolves the command, checks scope, and delegates
to the host or coordinator.
