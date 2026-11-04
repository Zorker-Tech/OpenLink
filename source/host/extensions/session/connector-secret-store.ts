/**
 * Where a connector's secrets are kept.
 *
 * One file per agent and platform, named with a safe folder id, written atomically and readable only by the agent that
 * owns it; a read that cannot be parsed is reported and treated as no secrets rather than as an error.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { reportSessionDiagnostic } from "./session-diagnostics.ts";
import type { ConnectorSecretDocument } from "./connector-secret-store-contracts.ts";
import {
  connectorSecretValue,
  decodeConnectorSecretDocument,
  hasSafeConnectorSecretCoordinates,
  mergeConnectorSecret,
} from "./connector-secret-store-policy.ts";

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

export class SlateConnectorSecretStore {
  constructor(readonly secretsRoot: string) {}

  filePath(agentId: string, platform: string): string {
    return join(this.secretsRoot, agentId, `${platform}.json`);
  }

  read(agentId: string, platform: string): ConnectorSecretDocument {
    try {
      const serialized = readFileSync(this.filePath(agentId, platform), "utf8");
      return decodeConnectorSecretDocument(JSON.parse(serialized) as unknown);
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        reportSessionDiagnostic({
          family: "store_db",
          kind: "connector_secrets_unreadable",
          agentId,
          errorClass: errorKind(error),
        });
      }
      return {};
    }
  }

  setSecret(agentId: string, platform: string, field: string, value: string): boolean {
    if (!hasSafeConnectorSecretCoordinates(agentId, platform) || field.length === 0) {
      return false;
    }

    const destination = this.filePath(agentId, platform);
    const nextDocument = mergeConnectorSecret(this.read(agentId, platform), field, value);
    mkdirSync(dirname(destination), { recursive: true });

    const stagingFile = `${destination}.${process.pid}.tmp`;
    writeFileSync(stagingFile, `${JSON.stringify(nextDocument, null, 2)}\n`, "utf8");
    renameSync(stagingFile, destination);
    return true;
  }

  getSecret(agentId: string, platform: string, field: string): string | null {
    if (!hasSafeConnectorSecretCoordinates(agentId, platform)) return null;
    return connectorSecretValue(this.read(agentId, platform), field);
  }

  removeAgentPlatform(agentId: string, platform: string): void {
    if (hasSafeConnectorSecretCoordinates(agentId, platform)) {
      rmSync(this.filePath(agentId, platform), { force: true });
    }
  }
}
