/**
 * Stamping the browser's user-agent with who owns it.
 *
 * What the stamp says is decided by the owner the caller reports, and the stamp is only rewritten when it would
 * say something different, so a browser that is already stamped is left alone.
 */
import { createHash } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";

import { parseJwtPayload } from "../../../shared/node/slate-token.ts";

export const UA_OWNER_STAMP_PATH = "/tmp/slate-ua-user";
export const UA_OWNER_STAMP_LENGTH = 16;

export function uaOwnerStampForAccessToken(accessToken: string): string | null {
  const subject = parseJwtPayload(accessToken)?.sub;
  if (subject == null || subject.length === 0) return null;
  return digestOwnerSubject(subject);
}

function digestOwnerSubject(subject: string): string {
  return createHash("sha256").update(subject, "utf8").digest("hex").slice(0, UA_OWNER_STAMP_LENGTH);
}

interface StampWriterOptions {
  readonly path?: string | undefined;
  readonly log: (message: string) => void;
}

export function createUaOwnerStampWriter(options: StampWriterOptions) {
  const destination = options.path ?? UA_OWNER_STAMP_PATH;
  let lastWritten: string | null = null;
  return async (token: string | null): Promise<void> => {
    const nextStamp = token == null ? null : uaOwnerStampForAccessToken(token);
    if (nextStamp === null || nextStamp === lastWritten) return;
    try {
      await replaceStampFile(destination, nextStamp);
      lastWritten = nextStamp;
    } catch (error) {
      options.log(`ua-owner stamp write failed: ${String(error)}`);
    }
  };
}

async function replaceStampFile(destination: string, stamp: string): Promise<void> {
  const stagingPath = `${destination}.tmp`;
  await writeFile(stagingPath, `${stamp}\n`, { encoding: "utf8", mode: 0o644 });
  await rename(stagingPath, destination);
}

