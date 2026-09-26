/**
 * The request context a host hands to the agent.
 *
 * It carries the platform, the shell, the time zone and where transcripts live, and adds the user's name when there is
 * one; the rules the agent is given are resolved on demand rather than up front.
 */
import { release, type } from "node:os";
import { normalizeSlateUserFullName } from "./slate-user-identity.ts";
export function resolveTimeZone(): string | undefined { try { return new Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; } catch { return undefined; } }
export function createHostRequestContext(transcriptsFolder: string, resolveUserTimeZone: () => string | undefined = () => undefined, resolveRules: () => Promise<readonly unknown[]> = async () => [], resolveUserFullName: () => string | undefined = () => undefined) {
  return { resolve: () => { const userFullName = normalizeSlateUserFullName(resolveUserFullName()); return { osVersion: `${type()} ${release()}`, shell: process.env.SHELL || undefined, timeZone: resolveUserTimeZone() ?? resolveTimeZone(), transcriptsFolder, ...(userFullName == null ? {} : { userFullName }) }; }, resolveRules };
}
