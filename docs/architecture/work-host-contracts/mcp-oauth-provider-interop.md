# MCP OAuth provider interop

Provider-specific hostnames, client-registration requirements, redirect restrictions, authorization parameters, and
scope strings live at the MCP interop boundary. The adapter currently recognizes the six supported Google Workspace
MCP hosts and keeps each host's exact scopes together. Slate's own desktop return scheme and route remain in the
product constants package.
