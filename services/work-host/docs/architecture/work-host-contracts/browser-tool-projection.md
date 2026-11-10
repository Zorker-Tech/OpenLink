# Browser MCP tool projection

Browser tools are selected by the provider identifiers declared at the MCP interop boundary. Their names are returned
in input order so prompt and shell descriptions stay aligned with the offered tool list.

When a provider must be named from a tool name, the resolver uses the prefix before the first `-browser_` marker. It
skips unmarked names and malformed names with an empty prefix, then returns the first valid provider name. With no
valid name it returns no provider.
