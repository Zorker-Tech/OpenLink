export type ConnectorSecretDocument = Record<string, unknown>;

export interface ConnectorSecretPathPort {
  filePath(agentId: string, platform: string): string;
}
