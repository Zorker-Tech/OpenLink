export function normalizeChannelLabel(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, 80)
}

export function channelDisplayName(raw?: string): string {
  const label = raw == null ? "" : normalizeChannelLabel(raw)
  return label.length > 0 ? label : "Connected channel"
}
