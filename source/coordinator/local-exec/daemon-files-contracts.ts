export interface LocalExecDaemonPaths {
  readonly connectionPath: string;
  readonly discoveryPath: string;
  readonly credentialPath: string;
  readonly logPath: string;
  readonly supervisorHeartbeatPath: string;
}

export interface LocalExecDaemonDiscovery {
  readonly pid: number;
  readonly startedAt: number;
  readonly entryRealpath?: string;
  readonly generationToken?: string;
  readonly inflightCount?: number;
}
