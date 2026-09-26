/**
 * What the client tells a service about itself.
 *
 * The version is the base of whatever the build stamped itself with, the type is the platform's own, and the box the
 * client belongs to is named in a header — with the build's variant deciding whether it is the development, the lab or
 * the production namespace, so a service can tell where a request came from without being told twice.
 */
import { getSlateVariant } from "./slate-variant.ts";

export const SLATE_CLIENT_TYPE = "slate";
export const SLATE_CLIENT_FALLBACK_BASE_VERSION = "0.1.0";
export const SLATE_CLIENT_VERSION_DEV_SUFFIX = "-dev";
export const SLATE_CLIENT_VERSION_LAB_SUFFIX = "-lab";
export const SLATE_BOX_NAMESPACE_HEADER = "x-slate-box-namespace";
const STAMPED_VERSION_BASE = /^(\d+\.\d+\.\d+)(?:-.+)?$/;

export type SandBoxNamespace = "dev" | "lab" | "prod";

export function getSlateClientBaseVersion(env: NodeJS.ProcessEnv = process.env): string {
  const stamped = env.SLATE_CLIENT_APP_VERSION?.trim() ?? "";
  return STAMPED_VERSION_BASE.exec(stamped)?.[1] ?? SLATE_CLIENT_FALLBACK_BASE_VERSION;
}

export function getSandBoxNamespace(env: NodeJS.ProcessEnv = process.env): SandBoxNamespace {
  const ownerNamespace = env.SLATE_BOX_OWNER_NAMESPACE?.trim();
  if (ownerNamespace === "dev" || ownerNamespace === "lab") return ownerNamespace;
  switch (getSlateVariant()) {
    case "slate-dev": return "dev";
    case "slate-lab": return "lab";
    default: return "prod";
  }
}

export function getSlateClientVersion(env: NodeJS.ProcessEnv = process.env): string {
  const baseVersion = getSlateClientBaseVersion(env);
  switch (getSandBoxNamespace(env)) {
    case "dev": return `${baseVersion}${SLATE_CLIENT_VERSION_DEV_SUFFIX}`;
    case "lab": return `${baseVersion}${SLATE_CLIENT_VERSION_LAB_SUFFIX}`;
    case "prod": return baseVersion;
  }
}

export function getSlateBackendClientHeaders(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return {
    "x-cursor-client-type": SLATE_CLIENT_TYPE,
    "x-cursor-client-version": getSlateClientVersion(env),
    [SLATE_BOX_NAMESPACE_HEADER]: getSandBoxNamespace(env)
  };
}
