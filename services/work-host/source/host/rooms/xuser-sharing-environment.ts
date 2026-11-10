/** Decides whether this host may open cross-account room sharing under its current build and backend. */
import { DEFAULT_BACKEND_URL } from "../../shared/node/slate-token.ts";

export const SLATE_DEV_XUSER_SHARING_ENV = "SLATE_DEV_XUSER_SHARING";
export const SLATE_XUSER_SHARING_ALLOW_PROD_ENV = "SLATE_XUSER_SHARING_ALLOW_PROD";

export interface XuserSharingEnvironment {
  readonly isAllowed: boolean;
  readonly reason?: string;
}

function developerBuild(env: NodeJS.ProcessEnv): boolean {
  return env.SLATE_PACKAGED !== "1" || env.SLATE_HOST_DEV_ERROR_DETAIL === "1";
}

function switchIsOn(env: NodeJS.ProcessEnv, key: string): boolean {
  return env[key] === "1";
}

function blockReasonForDeveloperBuild(): string {
  return `Sharing another user's computer is disabled on developer builds. A second box under this account can consume relay events needed by the active room. Set ${SLATE_DEV_XUSER_SHARING_ENV}=1 for a deliberate local test.`;
}

function blockReasonForProductionBackend(): string {
  return `This developer build is pointed at Slate's production backend. A second local sharing box can interfere with live room delivery. Set ${SLATE_XUSER_SHARING_ALLOW_PROD_ENV}=1 only for a deliberate production test.`;
}

export function isProductionBackendUrl(backendUrl: string): boolean {
  try {
    const requestedOrigin = new URL(backendUrl).origin;
    const productionOrigin = new URL(DEFAULT_BACKEND_URL).origin;
    return requestedOrigin === productionOrigin;
  } catch {
    return true;
  }
}

export function resolveXuserSharingEnvironment(args: {
  readonly backendUrl: string;
  readonly env?: NodeJS.ProcessEnv;
}): XuserSharingEnvironment {
  const env = args.env ?? process.env;
  if (!developerBuild(env)) return { isAllowed: true };
  if (!switchIsOn(env, SLATE_DEV_XUSER_SHARING_ENV)) {
    return { isAllowed: false, reason: blockReasonForDeveloperBuild() };
  }
  if (!isProductionBackendUrl(args.backendUrl)) return { isAllowed: true };
  if (switchIsOn(env, SLATE_XUSER_SHARING_ALLOW_PROD_ENV)) return { isAllowed: true };
  return { isAllowed: false, reason: blockReasonForProductionBackend() };
}
