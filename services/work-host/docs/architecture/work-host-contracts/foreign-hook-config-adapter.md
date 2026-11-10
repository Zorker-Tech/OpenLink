# Foreign hook configuration adapter

## Input and owned output

The adapter accepts the nested hook-file dialect and projects it into Slate's own `HookConfig` contract: version 1, Slate hook-step keys, command/prompt scripts, optional matcher/timeout, `loop_limit: null`, and `failClosed: false`.

Event names map to Slate hook steps. Unsupported and unknown events are reported and skipped. Tool matchers map known names to Slate tool names, keep MCP server identity, deduplicate results and drop unsupported tools; a matcher left empty skips the hook. Trigger matchers on non-tool events are reported and broadened to all triggers.

Scripts missing their required command or prompt are dropped. Multiple source entries for one event merge into the same Slate step. Dialect detection distinguishes nested entries from direct Slate scripts by the shape of the first usable entry.

## Verification

`tests/packages/hooks.test.ts` pins event and tool mappings, wildcard behavior, unsupported values, trigger warnings, script dropping, merged steps and dialect detection. The mapper lives under `adapters/interop`; the hook package owns the output contract.
