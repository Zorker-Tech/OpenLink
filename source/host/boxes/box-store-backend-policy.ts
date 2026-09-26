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
export interface BoxStoreBackendPolicy { readonly kind: BoxStoreBackendKind; readonly localDir?: string }
const policies = new WeakMap<object, BoxStoreBackendPolicy>();
export function resolveBackendKind(localDir: string | undefined, env: Record<string, string | undefined>): BoxStoreBackendKind { if (localDir != null) return "local-fs"; return env[SLATE_BOX_STORE_BACKEND_ENV]?.trim().toLowerCase() === "v2" ? "slate-box-store-v2" : "agent-store"; }
export function getBoxStoreBackendPolicy(env: Record<string, string | undefined> = process.env): BoxStoreBackendPolicy { const cached = policies.get(env); if (cached != null) return cached; const raw = env[SLATE_BOX_STORE_LOCAL_DIR_ENV]?.trim(), localDir = raw && isAbsolute(raw) ? raw : undefined, kind = resolveBackendKind(localDir, env), policy = Object.freeze({ kind, ...(localDir ? { localDir } : {}) }); policies.set(env, policy); return policy; }
function enabled(value: string | undefined): boolean { const raw = value?.trim().toLowerCase(); return raw === "1" || raw === "true" || raw === "yes"; }
export function isBoxStoreSyncEnabled(env: Record<string, string | undefined> = process.env): boolean { return enabled(env.SLATE_BOX_STORE_SYNC); }
export function isBoxStoreCopyInEnabled(env: Record<string, string | undefined> = process.env): boolean { return enabled(env.SLATE_BOX_STORE_COPY_IN); }
