import { isSafeFolderId } from "../../storage/folder-id.ts";
import type { ConnectorSecretDocument } from "./connector-secret-store-contracts.ts";

export function hasSafeConnectorSecretCoordinates(
  agentId: string,
  platform: string,
): boolean {
  return isSafeFolderId(agentId) && isSafeFolderId(platform);
}

export function decodeConnectorSecretDocument(value: unknown): ConnectorSecretDocument {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as ConnectorSecretDocument
    : {};
}

export function mergeConnectorSecret(
  current: ConnectorSecretDocument,
  field: string,
  value: string,
): ConnectorSecretDocument {
  return { ...current, [field]: value };
}

export function connectorSecretValue(
  document: ConnectorSecretDocument,
  field: string,
): string | null {
  const value = document[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}
