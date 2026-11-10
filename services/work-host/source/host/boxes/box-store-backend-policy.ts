/**
 * Where a box's store lives: a local directory, the backend's own store, or the agent store.
 *
 * A local directory wins when one is configured; otherwise the environment says which backend store to use, and the
 * agent store is the fallback. The policy is remembered per host so the same answer is not resolved twice, and the
 * switches that gate syncing and copying in are read from it.
 */
import { isAbsolute } from "node:path";

export const SLATE_BOX_STORE_LOCAL_DIR_ENV = "SLATE_BOX_STORE_LOCAL_DIR";
export const SLATE_BOX_STORE_BACKEND_ENV = "SLATE_BOX_STORE_BACKEND";
export type BoxStoreBackendKind = "local-fs" | "slate-box-store-v2" | "agent-store";

export interface BoxStoreBackendPolicy {
  readonly kind: BoxStoreBackendKind;
  readonly localDir?: string;
}

const policySnapshots = new WeakMap<object, BoxStoreBackendPolicy>();
const BACKEND_KIND_BY_VALUE = new Map<string, BoxStoreBackendKind>([
  ["v2", "slate-box-store-v2"],
]);
const ENABLED_FLAG_VALUES = new Set(["1", "true", "yes"]);

function configuredLocalDirectory(env: Record<string, string | undefined>): string | undefined {
  const candidate = env[SLATE_BOX_STORE_LOCAL_DIR_ENV]?.trim();
  return candidate && isAbsolute(candidate) ? candidate : undefined;
}

export function resolveBackendKind(
  localDir: string | undefined,
  env: Record<string, string | undefined>,
): BoxStoreBackendKind {
  if (localDir != null) return "local-fs";
  const configuredKind = env[SLATE_BOX_STORE_BACKEND_ENV]?.trim().toLowerCase() ?? "";
  return BACKEND_KIND_BY_VALUE.get(configuredKind) ?? "agent-store";
}

export function getBoxStoreBackendPolicy(
  env: Record<string, string | undefined> = process.env,
): BoxStoreBackendPolicy {
  const cached = policySnapshots.get(env);
  if (cached !== undefined) return cached;

  const localDir = configuredLocalDirectory(env);
  const kind = resolveBackendKind(localDir, env);
  const snapshot: BoxStoreBackendPolicy = Object.freeze({
    kind,
    ...(localDir === undefined ? {} : { localDir }),
  });
  policySnapshots.set(env, snapshot);
  return snapshot;
}

function enabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized !== undefined && ENABLED_FLAG_VALUES.has(normalized);
}

export function isBoxStoreSyncEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return enabled(env.SLATE_BOX_STORE_SYNC);
}

export function isBoxStoreCopyInEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return enabled(env.SLATE_BOX_STORE_COPY_IN);
}
