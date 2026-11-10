const ENABLED_VALUES = new Set(["1", "true", "yes"])

export function isStateBackstopEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const setting = env.SLATE_STATE_S3_BACKSTOP?.trim().toLowerCase() ?? ""
  return ENABLED_VALUES.has(setting)
}
