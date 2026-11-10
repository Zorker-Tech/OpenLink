# Selected image blob interop contract

The counterpart selected-image union remains inside the interop adapter. The Slate context pipeline receives hydrated
bytes and the normalized attachment reference from that boundary.

- Inline bytes are content-addressed, stored through the normal blob-store operation, and returned with a blob ID.
- A blob ID is resolved from the store; a missing blob fails hydration.
- Bytes that arrive together with an ID are stored locally only, then returned as the same ID reference.
- An unresolved prompt-upload reference fails hydration because its content is not available yet.
- An absent payload returns neither a normalized image nor bytes and performs no store operation.

Every successful reference case returns the image bytes required by downstream prompt processing. The Slate pipeline
does not interpret the generated union or copy its wire-specific variants into its own context model.
