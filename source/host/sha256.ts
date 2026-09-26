/** The digest the platform files content under. */
import { createHash } from "node:crypto";
export function sha256Hex(data: string | NodeJS.ArrayBufferView): string { return createHash("sha256").update(data).digest("hex"); }
