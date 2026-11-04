export function classifyBaseUrlKind(baseUrl: string | null | undefined): "unknown" | "loopback" | "pod_proxy" {
  if (baseUrl == null || baseUrl.length === 0) return "unknown";
  try {
    const hostname = new URL(baseUrl).hostname;
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]"
      ? "loopback"
      : "pod_proxy";
  } catch {
    return "unknown";
  }
}
