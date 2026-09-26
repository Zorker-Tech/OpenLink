/**
 * When sharing a room with another user's computer is allowed.
 *
 * It is a development feature: the switch that turns it on is read from the environment, and against the production
 * backend it needs a second switch, so a development build cannot share into production by accident.
 */
import { DEFAULT_BACKEND_URL } from "../../shared/node/cursor-token.ts";

export const SLATE_DEV_XUSER_SHARING_ENV = "SLATE_DEV_XUSER_SHARING";
export const SLATE_XUSER_SHARING_ALLOW_PROD_ENV = "SLATE_XUSER_SHARING_ALLOW_PROD";

export interface XuserSharingEnvironment {
  readonly isAllowed: boolean;
  readonly reason?: string;
}

export function isProductionBackendUrl(backendUrl: string): boolean {
  try {
    return new URL(backendUrl).origin === new URL(DEFAULT_BACKEND_URL).origin;
  } catch {
    return true;
  }
}

export function resolveXuserSharingEnvironment(args: {
  readonly backendUrl: string;
  readonly env?: NodeJS.ProcessEnv;
}): XuserSharingEnvironment {
  const env = args.env ?? process.env;
  const isDevBuild = env.SLATE_PACKAGED !== "1" || env.SLATE_HOST_DEV_ERROR_DETAIL === "1";
  if (!isDevBuild) return { isAllowed: true };
  if (env[SLATE_DEV_XUSER_SHARING_ENV] !== "1") {
    return {
      isAllowed: false,
      reason: `cross-user sharing stays OFF on this dev host: a second live box on the same account drains the account's relay events and corrupts prod room delivery. Set ${SLATE_DEV_XUSER_SHARING_ENV}=1 to opt this box in anyway.`,
    };
  }
  if (!isProductionBackendUrl(args.backendUrl)) return { isAllowed: true };
  if (env[SLATE_XUSER_SHARING_ALLOW_PROD_ENV] === "1") return { isAllowed: true };
  return {
    isAllowed: false,
    reason: `this dev host is pointed at the PRODUCTION backend; cross-user sharing stays off so it cannot ingest (or steal relay events from) the account's production rooms. Set ${SLATE_XUSER_SHARING_ALLOW_PROD_ENV}=1 to opt in deliberately.`,
  };
}
