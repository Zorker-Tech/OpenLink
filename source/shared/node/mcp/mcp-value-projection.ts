/** Projects message-like MCP values into plain JSON before core tool handlers see them. */

function projectMcpValue(value: unknown): unknown {
  if (value === null || typeof value !== "object" || !("toJson" in value)) return value
  const message = value as { readonly toJson?: unknown }
  return typeof message.toJson === "function" ? message.toJson() : value
}

export function projectMcpArguments(args: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).map(([key, value]) => [key, projectMcpValue(value)] as const),
  )
}
