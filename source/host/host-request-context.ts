import { release as osRelease, type as osType } from "node:os";
import { normalizeSlateUserFullName } from "./slate-user-identity.ts";

type UserNameProjection = { readonly userFullName?: string };

function platformDescription(): string {
  return `${osType()} ${osRelease()}`;
}

function shellDescription(): string | undefined {
  return process.env.SHELL || undefined;
}

function timeZoneDescription(resolveCustom: () => string | undefined): string | undefined {
  return resolveCustom() ?? resolveTimeZone();
}

function userNameProjection(resolveName: () => string | undefined): UserNameProjection {
  const name = normalizeSlateUserFullName(resolveName());
  return name == null ? {} : { userFullName: name };
}

export function resolveTimeZone(): string | undefined {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

export function createHostRequestContext(
  transcriptsFolder: string,
  resolveUserTimeZone: () => string | undefined = () => undefined,
  resolveRules: () => Promise<readonly unknown[]> = async () => [],
  resolveUserFullName: () => string | undefined = () => undefined,
) {
  const resolve = () => ({
    osVersion: platformDescription(),
    shell: shellDescription(),
    timeZone: timeZoneDescription(resolveUserTimeZone),
    transcriptsFolder,
    ...userNameProjection(resolveUserFullName),
  });

  return { resolve, resolveRules };
}
