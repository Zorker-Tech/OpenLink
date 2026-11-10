type ServerStatus = { status: string; statusDetail?: string }

export function projectBackendServerStatus(status: string | undefined): ServerStatus {
  switch (status) {
    case "connected": return { status: "connected" }
    case "needsAuth": return { status: "needsAuth", statusDetail: "Authentication required" }
    case "loading": return { status: "initializing" }
    case "error": return { status: "error", statusDetail: "Failed to load MCP server" }
    default: return { status: "error", statusDetail: "Not reported by backend" }
  }
}

export function projectBoxServerStatus(
  status: string | undefined,
  unavailable = false,
  detail?: string,
): ServerStatus {
  switch (status) {
    case "connected": return { status: "connected" }
    case "needsAuth": return { status: "needsAuth", statusDetail: "Authentication required" }
    case "loading": return { status: "initializing" }
    case "error": return { status: "error", statusDetail: detail && detail.length > 0 ? detail : "Failed to load MCP server" }
    default: return unavailable
      ? { status: "error", statusDetail: "Slate's computer unreachable" }
      : { status: "error", statusDetail: "Not reported by Slate's computer" }
  }
}
