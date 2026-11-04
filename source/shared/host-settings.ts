/** Notification policy selected when no host notification permission has been enabled. */
const DISABLED_NOTIFICATION_POLICY = {
  enabledAtStart: false,
  permittedApplicationNames: [],
  minimumSpacingMs: 5_000,
  maximumPerWindow: 10,
  windowDurationMs: 5 * 60_000,
} as const;

export const SLATE_DISABLED_NOTIFICATION_CONFIG = {
  isEnabled: DISABLED_NOTIFICATION_POLICY.enabledAtStart,
  allowedApps: [...DISABLED_NOTIFICATION_POLICY.permittedApplicationNames] as string[],
  minIntervalMs: DISABLED_NOTIFICATION_POLICY.minimumSpacingMs,
  maxPerWindow: DISABLED_NOTIFICATION_POLICY.maximumPerWindow,
  windowMs: DISABLED_NOTIFICATION_POLICY.windowDurationMs,
};
