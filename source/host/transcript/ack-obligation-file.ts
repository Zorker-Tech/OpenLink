import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SLATE_ACK_OBLIGATIONS_FILE_NAME } from "../durable-file-policy.ts";
import type { AckObligation } from "./ack-obligation-records.ts";
import { parseAckObligationsFile } from "./ack-obligation-records.ts";

export function ackObligationsPath(rootDir: string): string {
  return join(rootDir, SLATE_ACK_OBLIGATIONS_FILE_NAME);
}

export function readAckObligations(filePath: string): AckObligation[] {
  try {
    return parseAckObligationsFile(readFileSync(filePath, "utf8"));
  } catch {
    return [];
  }
}

export function writeAckObligations(filePath: string, pending: readonly AckObligation[]): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
  } catch {
    // Writing the temporary file will report whether the directory is usable.
  }
  const stagePath = `${filePath}.part`;
  writeFileSync(stagePath, JSON.stringify({ version: 1, pending }));
  renameSync(stagePath, filePath);
}
