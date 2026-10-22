/** The digest the platform files content under. */
import { createHash } from "node:crypto";

/** The algorithm the platform's content digests are taken with. */
const CONTENT_DIGEST_ALGORITHM = "sha256";

export function sha256Hex(content: string | NodeJS.ArrayBufferView): string {
  return createHash(CONTENT_DIGEST_ALGORITHM).update(content).digest("hex");
}