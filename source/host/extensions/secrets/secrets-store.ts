import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { getSlateRootDir } from "../../host-paths.ts";
import { BOX_SECRETS_FILENAME } from "./secrets-service-contracts.ts";

/** Resolve the durable record path from the host's selected Slate data root. */
export function getBoxSecretsStorePath(): string {
  return join(getSlateRootDir(), BOX_SECRETS_FILENAME);
}

/** Read only a version-one secret map whose values are all strings. */
export function parsePersistedBoxSecrets(value: unknown): Record<string, string> | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const storedSecrets = record.secrets;
  if (record.version !== 1 || typeof storedSecrets !== "object" || storedSecrets === null || Array.isArray(storedSecrets)) return null;

  const secrets: Record<string, string> = {};
  for (const [key, storedValue] of Object.entries(storedSecrets)) {
    if (typeof storedValue !== "string") return null;
    secrets[key] = storedValue;
  }
  return secrets;
}

export async function readPersistedBoxSecrets(path: string): Promise<Record<string, string> | null> {
  try {
    const text = await fs.readFile(path, "utf8");
    return parsePersistedBoxSecrets(JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

/** Atomically replace the private local record after the caller has accepted the new values. */
export async function writePersistedBoxSecrets(path: string, secrets: Readonly<Record<string, string>>): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const persisted = JSON.stringify({ version: 1, secrets });
  await fs.writeFile(temporaryPath, persisted, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporaryPath, path);
}
