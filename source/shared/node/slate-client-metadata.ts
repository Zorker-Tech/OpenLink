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
const CLIENT_VERSION_SUFFIX: Record<BoxNamespace, string> = {
  dev: SLATE_CLIENT_VERSION_DEV_SUFFIX,
  lab: SLATE_CLIENT_VERSION_LAB_SUFFIX,
  prod: "",
};

export type BoxNamespace = "dev" | "lab" | "prod";

export function getSlateClientBaseVersion(env: NodeJS.ProcessEnv = process.env): string {
  const candidate = env.SLATE_CLIENT_APP_VERSION?.trim();
  const base = candidate === undefined ? undefined : STAMPED_VERSION_BASE.exec(candidate)?.[1];
  return base ?? SLATE_CLIENT_FALLBACK_BASE_VERSION;
}

export function getBoxNamespace(env: NodeJS.ProcessEnv = process.env): BoxNamespace {
  const configured = env.SLATE_BOX_OWNER_NAMESPACE?.trim();
  if (configured === "dev" || configured === "lab") return configured;

  const variant = getSlateVariant();
  if (variant === "slate-dev") return "dev";
  if (variant === "slate-lab") return "lab";
  return "prod";
}

export function getSlateClientVersion(env: NodeJS.ProcessEnv = process.env): string {
  const base = getSlateClientBaseVersion(env);
  return base + CLIENT_VERSION_SUFFIX[getBoxNamespace(env)];
}
