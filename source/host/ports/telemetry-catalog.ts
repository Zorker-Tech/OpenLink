export const SLATE_BOX_BOOT_STAGES = ["entrypoint_started", "daemon_listening", "desktop_up", "ready"] as const
export const SLATE_BOX_BOOT_ID_ENV = "SLATE_BOX_BOOT_ID"
export const SLATE_BOX_BOOT_STARTED_AT_MS_ENV = "SLATE_BOX_BOOT_STARTED_AT_MS"
export const SLATE_BOX_AUTH_ID_ENV = "SLATE_BOX_AUTH_ID"
export const SLATE_BOX_TENANT_ID_ENV = "SLATE_BOX_TENANT_ID"
export const SLATE_BOX_STORE_ID_ENV = "SLATE_BOX_STORE_ID"
export const SLATE_BOX_CLUSTER_ENV = "SLATE_BOX_CLUSTER"

export function resolveBoxIdentityTags(env: NodeJS.ProcessEnv = process.env) {
  return {
    auth_id: env[SLATE_BOX_AUTH_ID_ENV]?.trim(),
    tenant_id: env[SLATE_BOX_TENANT_ID_ENV]?.trim(),
    box_store_id: env[SLATE_BOX_STORE_ID_ENV]?.trim(),
    box_boot_id: env[SLATE_BOX_BOOT_ID_ENV]?.trim(),
    cluster: env[SLATE_BOX_CLUSTER_ENV]?.trim(),
  }
}

export const SLATE_HOST_LIFECYCLE_PHASES = ["plugin_graph", "identity", "log_catchup", "transcript_read", "ready"] as const
export const SLATE_EXEC_DAEMON_RESTART_CAUSES = ["daemon_exited", "startup_listener_timeout", "listener_lost"] as const
export const SLATE_SUPERVISOR_RESTART_CAUSES = ["supervisor_exited", "startup_status_timeout", "status_stale", "gave_up"] as const
export const SLATE_COOKIE_PERSIST_PHASES = ["capture", "restore"] as const
export const SLATE_COOKIE_PERSIST_OUTCOMES = ["captured", "ok", "partial", "failed", "empty"] as const
export const SLATE_EGRESS_TUNNEL_OUTCOMES = ["ready", "restart", "startup_timeout", "listener_lost", "stale_port"] as const
export const SLATE_BOX_BOOT_FAILURE_STAGES = ["desktop"] as const
export const SLATE_BOX_BOOT_FAILURE_REASONS = ["x_display_timeout"] as const
export const SLATE_PROCESS_CRASH_BINARIES = ["cursor", "cursor-nightly", "cursor-lab", "chrome", "node", "exec-daemon", "xvfb", "xfwm4", "picom", "x11vnc", "websockify", "plank", "thunar", "xfce4-terminal", "other"] as const
export const SLATE_PROCESS_CRASH_SIGNALS = ["sigill", "sigsegv", "sigabrt", "sigbus", "other"] as const
export const SLATE_HOST_BOOT_FETCH_OUTCOMES = ["current", "applied", "fallback", "restore_failed"] as const
export const SLATE_HOST_BOOT_FETCH_REASONS = ["current", "applied", "pointer_unreachable", "pointer_malformed", "target_vetoed", "download_failed", "swap_refused", "swap_failed_restored", "restore_failed", "budget_exceeded", "unexpected_error"] as const
