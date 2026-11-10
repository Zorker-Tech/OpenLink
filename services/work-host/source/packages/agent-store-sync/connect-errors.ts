/**
 * What a failed call to the store's service means.
 *
 * The transport's error codes are read defensively — an error from anywhere is looked at by name and by shape — and
 * each is turned into the outcome the sync loop acts on: retry, give up, or re-authorize.
 */
import { Code, ConnectError } from "@connectrpc/connect";

/** The transport's codes by the name they are written with, read once rather than scanned per failure. */
const CODE_BY_NAME: ReadonlyMap<string, number> = new Map(
  Object.entries(Code).filter(([, value]) => typeof value === "number") as [string, number][],
);

/** The transport code a code value names, when it names one this build knows. */
function normalizeConnectCode(code: unknown): number | undefined {
  if (typeof code === "number" && typeof Code[code] === "string") return code;
  if (typeof code !== "string" || code.length === 0) return undefined;
  return CODE_BY_NAME.get(code);
}

/** The code an error carries, whether it came from the transport or from somewhere that copied its shape. */
function getAgentStoreConnectCode(error: unknown): number | undefined {
  if (error instanceof ConnectError) return error.code;
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return normalizeConnectCode(error.code);
}

/** The words a service uses when this build's sync is not enabled for the account. */
const SYNC_DISABLED_PHRASES: readonly string[] = [
  "agent store sync is not enabled",
  "agent store sync is not available in legacy privacy mode",
  "private worker agent-store sync is not enabled",
];

/** The message an error carries, as the text to read, and nothing when it carries none. */
function errorMessageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "";
}

function messageLooksLikeSyncDisabled(message: string): boolean {
  const lower = message.toLowerCase();
  return SYNC_DISABLED_PHRASES.some((phrase) => lower.includes(phrase));
}

export function carriesConnectCode(error: unknown, code: number): boolean {
  return getAgentStoreConnectCode(error) === code;
}

/** Whether an error carries one of these codes — the shape both questions below are asked in. */
function carriesOneOf(error: unknown, codes: readonly number[]): boolean {
  const code = getAgentStoreConnectCode(error);
  return code !== undefined && codes.includes(code);
}

/** Whether a mint failure is one worth remembering: the service said the request itself was wrong. */
export function mintFailureIsCacheable(error: unknown): boolean {
  return carriesOneOf(error, [Code.InvalidArgument, Code.NotFound, Code.FailedPrecondition]);
}

/**
 * Whether the service refused because sync is not enabled for this account.
 *
 * The words are what decide it — a refusal from a service that does not speak codes still means the same thing — and a
 * code, when there is one, has to be one of the two a refusal is given.
 */
export function syncIsDisabledForAccount(error: unknown): boolean {
  if (!messageLooksLikeSyncDisabled(errorMessageOf(error))) return false;
  // A refusal that carries no code still says what it means; one that carries a code has to be a refusal's own.
  if (getAgentStoreConnectCode(error) === undefined) return true;
  return carriesOneOf(error, [Code.InvalidArgument, Code.PermissionDenied]);
}
