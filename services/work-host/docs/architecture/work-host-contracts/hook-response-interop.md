# Hook response interop

Slate owns the hook-step catalogue and the `ValidationResult` returned to callers. Hook script response field names and
their per-step rules are interpreted by an interop adapter, because they are part of the foreign hook file/runtime
dialect.

The adapter requires an object envelope, ignores unknown fields, and reports every provided-but-invalid field together.
Missing optional fields are accepted. Action gates allow allow/deny/ask, read gates allow only allow/deny, tool-use can
rewrite input with a plain object, session-start environment entries must be strings, and stop/pre-compact/workspace-open
responses keep their own narrow field rules. The Slate registry chooses which validator applies to each Slate hook step.
