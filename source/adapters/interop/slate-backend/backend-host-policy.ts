/** Recognizes the hosted preview backend whose store addresses use a separate allowlist. */

export function isSlatePlaygroundBackend(backendUrl: string): boolean {
  try {
    const hostname = new URL(backendUrl).hostname.toLowerCase()
    return hostname === "playground.cursor.sh" || hostname.endsWith(".playground.cursor.sh")
  } catch {
    return false
  }
}
