# Computer-use conversation operation

The host's conversation state owns computer-use actions as a Slate operation. The durable operation uses a tagged
`computer-use` kind, action kinds such as `mouse-move`, `mouse-down`, and `cursor-position`, Slate button and direction
values, and explicit success, error, or unknown outcomes. The auto-review classifier receives the same product-owned
values in a `request` / `result` envelope; it does not consume generated oneof names or generated enum spellings.

The step serde writes `SLATE-AGENT-STEP` version 2. Historical generated conversation-step bytes and version 1 tool
records are read through the migration adapter and projected to this model. New step writes use the Slate envelope.
Unknown numeric button and direction codes remain represented as unknown enum values. Unknown binary fields are kept
in isolated migration metadata so rewriting a supported historical checkpoint does not discard them. Screenshot bytes
are never included in classifier context; the classifier receives only whether a screenshot was present.

The current computer-use executor resource still crosses the older generated executor message layer. That is an
internal protocol migration, not a product contract or a lasting external compatibility exemption. The overlap
inventory still carries a historical exemption for this adapter; remove it with the protocol migration. Completion
must move the host and box-exec consumer together to a versioned Slate-owned request/result contract before the
generated path can be removed. This conversation-operation slice does not claim that executor transport is migrated.

`slate-conversation-step-state.test.ts` pins all known action variants, unknown enum values, lossless projection of the
historical message, Slate version-1 record migration, and the Slate-native version-2 operation. The classifier context
suite pins the product-owned prompt shape and screenshot omission.
