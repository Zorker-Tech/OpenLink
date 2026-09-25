/**
 * Reading a failed connection by what it means.
 *
 * A connection can fail because the caller asked for something impossible, because it waited too long, because the
 * service is busy or because it is not there — and the ones worth retrying are told apart from the ones that will fail
 * the same way again. What the service said about when to come back is read from the failure's own metadata.
 */
import { parseRetryAfterHeaderMs } from "./retry-after.ts";
export const CONNECT_CODE_INVALID_ARGUMENT = 3; export const CONNECT_CODE_DEADLINE_EXCEEDED = 4; export const CONNECT_CODE_RESOURCE_EXHAUSTED = 8; export const CONNECT_CODE_UNAVAILABLE = 14;
interface ConnectErrorLike { readonly code: number; readonly metadata?: { get(name: string): string | null }; }
function isConnectErrorLike(error: unknown): error is ConnectErrorLike { return typeof error === "object" && error !== null && typeof (error as any).code === "number"; }
export function isRateLimitConnectError(error: unknown): boolean { return isConnectErrorLike(error) && error.code === CONNECT_CODE_RESOURCE_EXHAUSTED; } export function isInvalidArgumentConnectError(error: unknown): boolean { return isConnectErrorLike(error) && error.code === CONNECT_CODE_INVALID_ARGUMENT; } export function isDeadlineExceededConnectError(error: unknown): boolean { return isConnectErrorLike(error) && error.code === CONNECT_CODE_DEADLINE_EXCEEDED; } export function isTransientConnectError(error: unknown): boolean { return isConnectErrorLike(error) && (error.code === CONNECT_CODE_UNAVAILABLE || error.code === CONNECT_CODE_DEADLINE_EXCEEDED || error.code === CONNECT_CODE_RESOURCE_EXHAUSTED); } export function getConnectRetryAfterMs(error: unknown, nowMs = Date.now()): number | undefined { return isConnectErrorLike(error) ? parseRetryAfterHeaderMs(error.metadata?.get("retry-after"), nowMs) : undefined; }
