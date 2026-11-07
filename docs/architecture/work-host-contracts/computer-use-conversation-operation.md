# Computer-use conversation operation

The host's conversation state owns computer-use actions as a Slate operation. The durable operation uses a tagged
`computer-use` kind, action kinds such as `mouse-move`, `mouse-down`, and `cursor-position`, Slate button and direction
values, and explicit success, error, or unknown outcomes. The auto-review classifier receives the same product-owned
values in a `request` / `result` envelope; it does not consume generated oneof names or generated enum spellings. The
agent tool parser and host dependency port now use the same Slate action union and result vocabulary, so request
construction, result display, screenshot persistence and executor projection do not exchange generated oneof-shaped
objects inside the host. Coordinates and scroll amounts are bounded to signed 32-bit values before the executor edge,
and enum lookup uses explicit cases so inherited object-property names cannot become mouse buttons or directions.

The step serde writes `SLATE-AGENT-STEP` version 2. Historical generated conversation-step bytes and version 1 tool
records are read through the migration adapter and projected to this model. New step writes use the Slate envelope.
Unknown numeric button and direction codes remain represented as unknown enum values. Unknown binary fields are kept
in isolated migration metadata so rewriting a supported historical checkpoint does not discard them. Screenshot bytes
are never included in classifier context; the classifier receives only whether a screenshot was present.

The public `computerUseExecutorResource` also exposes the Slate request/result types. Its adapter encodes those values
to the older generated executor envelope and decodes back; both remote and controlled directions are pinned. That is
an internal protocol migration, not a product contract or a lasting external compatibility exemption. The overlap
inventory still carries a historical exemption for this adapter; remove it with the protocol migration. Completion
must move the host and box-exec consumer together to a versioned Slate-owned request/result contract before the
generated path can be removed. The adapter preserves action counts, elapsed time, logs, screenshot paths, screenshot
data and cursor coordinates in both success and error outcomes. The default Slate box-exec daemon currently reports
computer-use as unsupported; this slice does not claim to add that desktop execution backend or to change the
advertised capability.

`host-computer-tool.test.ts` pins Slate action projection, validation, defaults, result rendering and screenshot
persistence. `host-computer-tool-dependencies.test.ts` pins the Slate host port and executor message mapping.
`slate-computer-use-resource-adapter.test.ts` pins generated message conversion in both directions, all action kinds,
all result metadata, unknown enum preservation and malformed values. `host-remote-box-resources.test.ts` pins Slate action
audit values. The step-state test pins historical action variants and lossless recovery; the classifier context suite
pins the product-owned prompt shape and screenshot omission.
