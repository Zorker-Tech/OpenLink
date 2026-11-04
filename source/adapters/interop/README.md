# External wire contracts

This directory holds the external protobuf schemas and generated bindings that Slate still needs
to communicate with counterpart services. They are not the schema for Slate's Work HTTP/SSE API,
host persistence, or application domain types.

Service-specific clients and transport mappings, including the inference and image service adapters,
also live under this boundary.

The selected-image blob adapter translates generated image references into the host blob store's
read/write operations while preserving whether bytes arrived inline, by reference, or unresolved.

The protobuf blob serde wraps generated message encoders for persistence while the blob-store interfaces
and byte-format utilities stay in the Slate domain.

The selected-context skill adapter translates the generated skill/rule records into the host's attachment
model; preference and inference rules remain in the Slate-owned skill attachment policy.

MCP transport error text and JSON-RPC codes are classified here into the host's tool-error categories.

The plugin-marketplace dashboard client is kept here with its provider-specific request headers and
Connect service binding. Product code calls it through the client surface rather than carrying those
request details.

Provider-owned message metadata is decoded here as well. The user-turn classifier consumes a boolean
summary-origin result and does not depend on the provider's `providerOptions` layout.

The local conversation-state reader contains a narrow compatibility decoder for the existing persisted
binary shape. Host recovery consumes only its Slate snapshot view, not the generated message class.

Small translations from external marketplace markers to Slate-owned source categories belong here too;
for example, `plugin-origin.ts` maps the public-feed marker while the plugin loader only sees
`first-party` or `third-party`.

The direct consumers outside this adapter directory are recorded in
apps/work-host/scripts/interop-proto-consumers.txt. The interop:check command rejects new direct consumers and
stale entries, so each migration to a Slate-owned adapter removes one dependency from that list.
The Work API contract lives in packages/work-protocol.
