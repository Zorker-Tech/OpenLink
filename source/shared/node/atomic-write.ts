import { randomBytes } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * Writing a file whole or not at all: the bytes go into a staging file beside the target, are flushed to it, and only
 * then replace the target in one rename — so a write that fails partway never leaves a half-written file behind.
 */

/** The staging file sits in the target's own directory, so that the rename stays on one file system. */
const STAGING_PREFIX = ".";
const STAGING_SUFFIX = ".part";
const RANDOM_BYTES = 8;
const CREATE_ONLY = "wx";
const CREATE_DIRECTORIES = { recursive: true } as const;

type CloseableFile = { close(): Promise<void> };

function stagingPathFor(targetPath: string): string {
  const nonce = randomBytes(RANDOM_BYTES).toString("hex");
  return join(dirname(targetPath), `${STAGING_PREFIX}${basename(targetPath)}.${nonce}${STAGING_SUFFIX}`);
}

/** Removing the staging file is best effort: the error that brought us here is the one worth reporting. */
async function discard(filePath: string): Promise<void> {
  await unlink(filePath).catch(() => {});
}

async function closeQuietly(file: CloseableFile): Promise<void> {
  await file.close().catch(() => {});
}

export async function writeFileAtomic(targetPath: string, data: Uint8Array | string, options: { readonly mode?: number } = {}): Promise<void> {
  await mkdir(dirname(targetPath), CREATE_DIRECTORIES);
  const stagingPath = stagingPathFor(targetPath);
  const file = await open(stagingPath, CREATE_ONLY, options.mode);
  try {
    await file.writeFile(data);
    await file.sync();
  } catch (error) {
    await closeQuietly(file);
    await discard(stagingPath);
    throw error;
  }
  await file.close();
  try {
    await rename(stagingPath, targetPath);
  } catch (error) {
    await discard(stagingPath);
    throw error;
  }
}
