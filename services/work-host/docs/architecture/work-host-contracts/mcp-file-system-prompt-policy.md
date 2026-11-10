# MCP filesystem prompt policy

The filesystem route is described only when its own option is enabled, the compatibility feature flag is on, and at
least one descriptor is available. It is suppressed when the MCP meta tool is enabled because that route owns discovery
and invocation. Ask mode also suppresses it by default while edit tools are filtered; an explicit setting that disables
that filter leaves the route available.

For an eligible route, model metadata selects PascalCase tool names or snake_case names. The prompt includes each server
identifier, descriptor path, optional server instructions, and resource access names. The resulting text ends with the
partial-work reporting rule. The model profile and file-system options are Slate-owned inputs after protocol projection;
the response text template remains behind the MCP interop adapter.
