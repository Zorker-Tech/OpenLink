export const SLATE_AGENT_FALLBACK_PREVIEW = "Slate cloud agent"

export function slateAgentPreviewText(title?: string | null): string {
  const trimmed = title?.trim()
  return trimmed !== undefined && trimmed.length > 0
    ? `Slate agent: ${trimmed}`
    : SLATE_AGENT_FALLBACK_PREVIEW
}

export function connectorsPreviewText(connectors: readonly string[]): string {
  if (connectors.length === 0) return "Connect tools"
  return `Connect ${connectors.join(", ")}`
}
