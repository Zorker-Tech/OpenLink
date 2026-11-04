import { findSystemErrno } from "../../shared/system-errno.ts";
import { BoxFileUnreadableError } from "./box-transfer-contracts.ts";

function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Treat the typed box error and common filesystem ENOENT forms as a missing source. */
export function isSourceMissingError(error: unknown): boolean {
  if (error instanceof BoxFileUnreadableError || findSystemErrno(error) === "ENOENT") return true;
  const detail = describeFailure(error).toLowerCase();
  return detail.includes("no such file or directory") || detail.includes("enoent");
}

export function errorDescription(error: unknown): string {
  return describeFailure(error);
}
