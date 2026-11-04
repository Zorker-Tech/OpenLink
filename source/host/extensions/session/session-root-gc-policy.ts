let enabledByHost = false;

export function setStaleRootGcOverride(enabled: boolean): void {
  enabledByHost = enabled;
}

export function shouldCollectStaleSessionRoots(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const setting = env.SLATE_STALE_ROOT_GC?.trim().toLowerCase();
  if (setting === "1" || setting === "true" || setting === "on") return true;
  if (setting === "0" || setting === "false" || setting === "off") return false;
  return enabledByHost;
}
