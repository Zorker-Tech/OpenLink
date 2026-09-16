# Coordinator

Supervises and connects the pieces the host depends on.

| Module | Responsibility |
| --- | --- |
| gateway client | Typed client used by local clients to reach the gateway |
| host supervisor | Start, watch, restart, and drain the host process |
| local-exec supervisor | Own the local-exec daemon lifecycle and its identity/readiness records |
| inference router | Route model requests to the configured provider per agent policy |
| oauth forwarder | Complete OAuth flows that begin inside Box/browser sessions |
| webauthn | Presence checks for sensitive operations |
| MCP bridge | Route MCP tool calls to the right transport |
| telemetry | Export traces/metrics with redaction applied at the boundary |

The coordinator never asserts authority it does not have: it forwards, it does not decide
permissions.
