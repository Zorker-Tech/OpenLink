/** Validated records exchanged by the local-exec daemon and its supervisor. */
export interface LocalExecConnection {
  readonly baseUrl: string;
  readonly token?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface LocalExecDiscovery {
  readonly pid: number;
  readonly startedAt: number;
  readonly entryRealpath?: string;
  readonly generationToken?: string;
  readonly inflightCount?: number;
}

export interface LocalExecSupervisorHeartbeat {
  readonly pid: number;
  readonly at: number;
}

export interface LocalExecCredential {
  readonly credential: string;
  readonly backendUrl: string;
  readonly expiresAtMs?: number;
}

export const NO_SUPERVISOR_HEARTBEAT = { pid: 0, at: 0 } as const;

function objectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function optionalStringValue(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function positiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function validHeaders(value: unknown): value is Record<string, string> {
  return objectRecord(value) && Object.values(value).every((header) => typeof header === "string");
}

/** Accept a connection record only when every optional transport value has the shape callers expect. */
export function parseLocalExecConnection(value: unknown): LocalExecConnection | null {
  if (!objectRecord(value) || typeof value.baseUrl !== "string" || value.baseUrl.length === 0) return null;
  if (!optionalStringValue(value.token)) return null;
  if (value.headers !== undefined && !validHeaders(value.headers)) return null;

  return {
    baseUrl: value.baseUrl,
    ...(value.token === undefined ? {} : { token: value.token }),
    ...(value.headers === undefined ? {} : { headers: value.headers }),
  };
}

function optionalInflightCount(value: unknown): value is number | undefined {
  return value === undefined || (Number.isInteger(value) && (value as number) >= 0);
}

function optionalIdentityPath(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === "string" && value.length > 0);
}

/** Parse the process identity that protects discovery records from stale owners. */
export function parseLocalExecDiscovery(value: unknown): LocalExecDiscovery | null {
  if (!objectRecord(value) || !positiveInteger(value.pid)) return null;
  if (typeof value.startedAt !== "number" || !Number.isFinite(value.startedAt)) return null;
  if (!optionalInflightCount(value.inflightCount)) return null;
  if (!optionalIdentityPath(value.entryRealpath) || !optionalIdentityPath(value.generationToken)) return null;

  return {
    pid: value.pid,
    startedAt: value.startedAt,
    ...(value.entryRealpath === undefined ? {} : { entryRealpath: value.entryRealpath }),
    ...(value.generationToken === undefined ? {} : { generationToken: value.generationToken }),
    ...(value.inflightCount === undefined ? {} : { inflightCount: value.inflightCount }),
  };
}

export function parseLocalExecSupervisorHeartbeat(value: unknown): LocalExecSupervisorHeartbeat | null {
  if (!objectRecord(value) || !positiveInteger(value.pid) || typeof value.at !== "number") return null;
  return { pid: value.pid, at: value.at };
}

/** A handoff credential is useful only when both credential and backend address are present. */
export function parseLocalExecCredential(value: unknown): LocalExecCredential | null {
  if (!objectRecord(value)) return null;
  if (typeof value.credential !== "string" || value.credential.length === 0) return null;
  if (typeof value.backendUrl !== "string" || value.backendUrl.length === 0) return null;
  if (value.expiresAtMs !== undefined && typeof value.expiresAtMs !== "number") return null;
  return {
    credential: value.credential,
    backendUrl: value.backendUrl,
    ...(value.expiresAtMs === undefined ? {} : { expiresAtMs: value.expiresAtMs }),
  };
}
