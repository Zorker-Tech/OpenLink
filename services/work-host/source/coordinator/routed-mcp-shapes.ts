/** Read an object shape carried across the local JSON-RPC connection. */
export function routedMcpRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
