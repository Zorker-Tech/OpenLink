# Persisted subagent state resolution contract

Conversation state may carry a subagent snapshot inline, by blob reference, or both. Reads begin with the inline map;
a successfully fetched and decoded reference replaces that subagent's inline value.

References are fetched with a concurrency cap of eight and applied in the input order. A missing blob with an inline
value keeps that value and emits a warning. Missing blobs without inline values are collected into one
`BlobNotFoundError`, so the caller can identify all unrecoverable references. A present but undecodable blob is a
corruption error and is propagated even when an inline value exists. The resolver returns immediately with a shallow
copy when there are no references.
