import { randomBytes } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { getSlateRootDir } from "../../host-paths.ts"

export const TEACH_QUEUE_KEY_FILENAME = "teach-queue-key.json"
const QUEUE_KEY_BYTES = 32

function queueKeyDocument(raw: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(raw)
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

export function parseTeachQueueKey(raw: string): Buffer | null {
  const document = queueKeyDocument(raw)
  if (document?.version !== 1 || typeof document.keyHex !== "string") return null
  const key = Buffer.from(document.keyHex, "hex")
  return key.length === QUEUE_KEY_BYTES && key.toString("hex") === document.keyHex ? key : null
}

async function readExistingQueueKey(filePath: string): Promise<Buffer | null> {
  try {
    return parseTeachQueueKey(await readFile(filePath, "utf8"))
  } catch {
    return null
  }
}

async function writeNewQueueKey(root: string, filePath: string): Promise<Buffer> {
  const key = randomBytes(QUEUE_KEY_BYTES)
  await mkdir(root, { recursive: true })
  await writeFile(filePath, JSON.stringify({ version: 1, keyHex: key.toString("hex") }), { mode: 0o600 })
  return key
}

export async function loadTeachQueueKey(slateRoot = getSlateRootDir()): Promise<Buffer> {
  const filePath = join(slateRoot, TEACH_QUEUE_KEY_FILENAME)
  const existing = await readExistingQueueKey(filePath)
  return existing ?? await writeNewQueueKey(slateRoot, filePath)
}
