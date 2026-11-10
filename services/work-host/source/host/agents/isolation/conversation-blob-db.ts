/** The database a conversation's blobs live in.

 * It is opened with the settings it needs, checked before it is trusted, and — when its file turns out to be damaged —
 * rebuilt: what can still be read is salvaged into a candidate, the damaged file is kept aside rather than thrown
 * away, and a rebuild that was interrupted is finished the next time the conversation is opened. */
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isSqliteCantOpenError, isSqliteCorruptError, isSqliteIoError } from "../../storage/sqlite-busy.ts";
import {
  copySalvageableSqliteRows,
  openSqliteForSalvage,
  quarantineCorruptSqliteDb,
  removeSqliteDb,
  removeSqliteSidecars as removeSqliteRecoverySidecars,
} from "../../storage/sqlite-recovery.ts";

export const CONVERSATION_BLOB_SCHEMA = `
CREATE TABLE IF NOT EXISTS blobs (
  id TEXT PRIMARY KEY,
  data BLOB NOT NULL
) STRICT;
`;

export const CONVERSATION_BLOB_MIGRATION_UNSTARTED = 0;
export const CONVERSATION_BLOB_ADOPTION_COMPLETE = 1;
export const CONVERSATION_BLOB_RECOVERY_REBUILT = 2;

export type ConversationBlobMigrationState = "unstarted" | "adoption-complete" | "recovery-rebuilt" | "unknown";

export class ConversationBlobRecoveryError extends Error {
  override name = "ConversationBlobRecoveryError";

  constructor(readonly code: string, message: string) {
    super(message);
  }
}

interface RecoveryOutcome {
  outcome: "recovered" | "reset";
  quarantinePath: string | null;
  salvagedBlobs: number;
}

interface BlobDbSettings {
  dbPath: string;
  busyTimeoutMs: number;
  agentId: string;
  log?: (message: string) => void;
  onRecovery?: (recoveryInfo: RecoveryOutcome) => void;
}

interface PendingRecovery {
  pendingPath: string;
  quarantinePath: string;
}

export function readConversationBlobMigrationState(connection: DatabaseSync): ConversationBlobMigrationState {
  let version: unknown;
  try {
    version = (connection.prepare("PRAGMA user_version").get() as { user_version?: unknown } | undefined)?.user_version;
  } catch {
    return "unknown";
  }
  switch (version ?? CONVERSATION_BLOB_MIGRATION_UNSTARTED) {
    case CONVERSATION_BLOB_MIGRATION_UNSTARTED:
      return "unstarted";
    case CONVERSATION_BLOB_ADOPTION_COMPLETE:
      return "adoption-complete";
    case CONVERSATION_BLOB_RECOVERY_REBUILT:
      return "recovery-rebuilt";
    default:
      return "unknown";
  }
}

export function openConfiguredConversationBlobDb(dbPath: string, busyTimeoutMs: number): DatabaseSync {
  const connection = new DatabaseSync(dbPath);
  try {
    connection.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    try {
      connection.exec("PRAGMA journal_mode = WAL");
      connection.exec("PRAGMA synchronous = NORMAL");
    } catch {
      // The database can still be opened when journal configuration is unavailable.
    }
    connection.exec(CONVERSATION_BLOB_SCHEMA);
    return connection;
  } catch (error) {
    try {
      connection.close();
    } catch {
      // Preserve the original database error.
    }
    throw error;
  }
}

export function runQuickCheck(connection: DatabaseSync): "healthy" | "corrupt" {
  const row = connection.prepare("PRAGMA quick_check").get() as { quick_check?: unknown } | undefined;
  return row?.quick_check === "ok" ? "healthy" : "corrupt";
}

export function removeSqliteSidecars(path: string): void {
  removeSqliteRecoverySidecars(path);
}

function healthOf(connection: DatabaseSync): "healthy" | "corrupt" | "unavailable" {
  try {
    return runQuickCheck(connection);
  } catch (error) {
    return isSqliteCorruptError(error) ? "corrupt" : "unavailable";
  }
}

function healthOnDiskOf(settings: Pick<BlobDbSettings, "dbPath" | "busyTimeoutMs">): "healthy" | "corrupt" | "unavailable" {
  for (let tryIndex = 0; tryIndex < 2; tryIndex += 1) {
    let connection: DatabaseSync | undefined;
    try {
      connection = new DatabaseSync(settings.dbPath, { readOnly: true });
      connection.exec(`PRAGMA busy_timeout = ${settings.busyTimeoutMs}`);
      return runQuickCheck(connection);
    } catch (error) {
      if (tryIndex === 0 && (isSqliteIoError(error) || isSqliteCantOpenError(error))) {
        try {
          connection?.close();
        } catch {
          // Continue with the sidecar cleanup retry.
        }
        connection = undefined;
        removeSqliteSidecars(settings.dbPath);
        continue;
      }
      return isSqliteCorruptError(error) ? "corrupt" : "unavailable";
    } finally {
      try {
        connection?.close();
      } catch {
        // Preserve the condition result.
      }
    }
  }
  return "unavailable";
}

export function recoverConversationBlobDb(settings: BlobDbSettings): DatabaseSync {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const intendedQuarantinePath = `${settings.dbPath}.corrupt-${timestamp}`;
  const intentMarkerPath = `${intendedQuarantinePath}.intent`;
  writeFileSync(intentMarkerPath, "");
  const quarantine = quarantineCorruptSqliteDb({
    dbPath: settings.dbPath,
    quarantinePath: intendedQuarantinePath,
    preserveSourceOnCopyFailure: true,
    removeAttempts: Math.ceil(settings.busyTimeoutMs / 50),
    removeRetryDelayMs: 50,
  });
  const pendingPath = `${quarantine.quarantinePath ?? intendedQuarantinePath}.pending`;
  renameSync(intentMarkerPath, pendingPath);
  if (quarantine.renameErrorCode != null) {
    settings.log?.(
      quarantine.quarantinePath == null
        ? `[agent-store-worker] could not quarantine conversation-blobs.db for agent=${settings.agentId} (rename ${quarantine.renameErrorCode}); resetting without a preserved copy`
        : quarantine.copied
          ? `[agent-store-worker] quarantined conversation-blobs.db by copy for agent=${settings.agentId} (rename ${quarantine.renameErrorCode})`
          : `[agent-store-worker] could not copy quarantine for conversation-blobs.db for agent=${settings.agentId} (rename ${quarantine.renameErrorCode}); recovering from the source in place`,
    );
  }
  return completeRecovery({
    settings,
    quarantinePath: quarantine.quarantinePath,
    pendingPath,
  });
}

function openHealthyTarget(settings: Pick<BlobDbSettings, "busyTimeoutMs">, dbPath: string): DatabaseSync {
  const open = () => openConfiguredConversationBlobDb(dbPath, settings.busyTimeoutMs);
  const remove = () =>
    removeSqliteDb({
      dbPath,
      attempts: Math.ceil(settings.busyTimeoutMs / 50),
      retryDelayMs: 50,
    });
  let retriedWithoutSidecars = false;
  for (let tryIndex = 0; tryIndex < 3; tryIndex += 1) {
    let connection: DatabaseSync | undefined;
    try {
      connection = open();
    } catch (error) {
      if ((isSqliteIoError(error) || isSqliteCantOpenError(error)) && !retriedWithoutSidecars) {
        retriedWithoutSidecars = true;
        removeSqliteSidecars(dbPath);
        continue;
      }
      if (!isSqliteIoError(error) && !isSqliteCorruptError(error) && !isSqliteCantOpenError(error)) {
        throw error;
      }
      remove();
      continue;
    }
    const condition = healthOf(connection);
    if (condition === "healthy") return connection;
    try {
      connection.close();
    } catch {
      // Continue recovery using the replacement path.
    }
    if (condition === "unavailable") {
      throw new ConversationBlobRecoveryError(
        "SLATE_BLOB_RECOVERY_TARGET_UNHEALTHY",
        "conversation blob recovery target is temporarily unavailable",
      );
    }
    remove();
  }
  throw new ConversationBlobRecoveryError(
    "SLATE_BLOB_RECOVERY_TARGET_UNHEALTHY",
    "failed to create a healthy conversation blob database",
  );
}

function installFinishedReplacement(settings: {
  dbPath: string;
  replacementPath: string;
  pendingPath?: string;
  busyTimeoutMs: number;
}): DatabaseSync | undefined {
  const condition = healthOnDiskOf({
    dbPath: settings.replacementPath,
    busyTimeoutMs: settings.busyTimeoutMs,
  });
  if (condition === "unavailable") {
    throw new ConversationBlobRecoveryError(
      "SLATE_BLOB_RECOVERY_SOURCE_UNAVAILABLE",
      "completed conversation blob replacement is temporarily unavailable",
    );
  }
  if (condition === "corrupt") return undefined;
  let candidate: DatabaseSync | undefined;
  try {
    candidate = openConfiguredConversationBlobDb(settings.replacementPath, settings.busyTimeoutMs);
    const configuredHealth = healthOf(candidate);
    if (configuredHealth === "corrupt") return undefined;
    if (configuredHealth === "unavailable") {
      throw new ConversationBlobRecoveryError(
        "SLATE_BLOB_RECOVERY_SOURCE_UNAVAILABLE",
        "completed conversation blob replacement became unavailable",
      );
    }
    const replacementState = readConversationBlobMigrationState(candidate);
    if (replacementState !== "recovery-rebuilt" && replacementState !== "adoption-complete") return undefined;
    candidate.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    candidate.exec("PRAGMA journal_mode = DELETE");
  } catch (error) {
    if (isSqliteCorruptError(error)) return undefined;
    throw error;
  } finally {
    try {
      candidate?.close();
    } catch {
      // Preserve the candidate result/error.
    }
  }
  removeSqliteSidecars(settings.replacementPath);
  removeSqliteDb({ dbPath: settings.dbPath });
  renameSync(settings.replacementPath, settings.dbPath);
  const readyDb = openConfiguredConversationBlobDb(settings.dbPath, settings.busyTimeoutMs);
  if (healthOf(readyDb) !== "healthy") {
    readyDb.close();
    throw new ConversationBlobRecoveryError(
      "SLATE_BLOB_RECOVERY_INSTALL_UNHEALTHY",
      "installed completed conversation blob replacement is unhealthy",
    );
  }
  if (settings.pendingPath != null) rmSync(settings.pendingPath, { force: true });
  return readyDb;
}

function completeRecovery(args: {
  settings: BlobDbSettings;
  quarantinePath: string | null;
  pendingPath: string | null;
}): DatabaseSync {
  const { settings } = args;
  let pendingPath = args.pendingPath;
  let quarantinePath = args.quarantinePath;
  let replacementPath = `${quarantinePath ?? settings.dbPath}.replacement`;
  if (!existsSync(settings.dbPath) && existsSync(replacementPath)) {
    const readyDb = installFinishedReplacement({
      dbPath: settings.dbPath,
      replacementPath,
      busyTimeoutMs: settings.busyTimeoutMs,
      ...(pendingPath == null ? {} : { pendingPath }),
    });
    if (readyDb != null) return readyDb;
    const hasSeparateQuarantine =
      quarantinePath != null && quarantinePath !== settings.dbPath && existsSync(quarantinePath);
    if (!hasSeparateQuarantine) {
      quarantinePath = replacementPath;
      replacementPath = `${replacementPath}.replacement`;
    }
  }
  if (existsSync(settings.dbPath)) {
    let current: DatabaseSync | undefined;
    const sourceHealth = healthOnDiskOf({
      dbPath: settings.dbPath,
      busyTimeoutMs: settings.busyTimeoutMs,
    });
    if (sourceHealth === "unavailable") {
      throw new ConversationBlobRecoveryError(
        "SLATE_BLOB_RECOVERY_SOURCE_UNAVAILABLE",
        "conversation blob recovery source is temporarily unavailable",
      );
    }
    if (sourceHealth === "healthy") {
      try {
        current = openConfiguredConversationBlobDb(settings.dbPath, settings.busyTimeoutMs);
      } catch (error) {
        if (!isSqliteCorruptError(error)) {
          throw new ConversationBlobRecoveryError(
            "SLATE_BLOB_RECOVERY_SOURCE_UNAVAILABLE",
            "healthy conversation blob recovery source could not be configured",
          );
        }
      }
      const configuredHealth = current == null ? "corrupt" : healthOf(current);
      if (configuredHealth === "healthy" && current != null) {
        if (quarantinePath != null) removeSqliteDb({ dbPath: `${quarantinePath}.replacement` });
        if (pendingPath != null) rmSync(pendingPath, { force: true });
        return current;
      }
      if (configuredHealth === "unavailable") {
        try {
          current?.close();
        } catch {
          // Preserve the source-unavailable result.
        }
        throw new ConversationBlobRecoveryError(
          "SLATE_BLOB_RECOVERY_SOURCE_UNAVAILABLE",
          "conversation blob recovery source became temporarily unavailable",
        );
      }
    }
    try {
      current?.close();
    } catch {
      // Continue with salvage.
    }
    if (quarantinePath === settings.dbPath) {
      // The source itself is the salvage path when it could not be moved.
    } else if (quarantinePath != null && !existsSync(quarantinePath)) {
      const quarantine = quarantineCorruptSqliteDb({
        dbPath: settings.dbPath,
        quarantinePath,
        preserveSourceOnCopyFailure: true,
        removeAttempts: Math.ceil(settings.busyTimeoutMs / 50),
        removeRetryDelayMs: 50,
      });
      quarantinePath = quarantine.quarantinePath;
      const resumedPendingPath = quarantinePath == null ? null : `${quarantinePath}.pending`;
      if (pendingPath != null && resumedPendingPath != null && pendingPath !== resumedPendingPath) {
        renameSync(pendingPath, resumedPendingPath);
        pendingPath = resumedPendingPath;
      }
      replacementPath = `${quarantinePath ?? settings.dbPath}.replacement`;
    } else {
      removeSqliteDb({
        dbPath: settings.dbPath,
        attempts: Math.ceil(settings.busyTimeoutMs / 50),
        retryDelayMs: 50,
      });
    }
  }
  removeSqliteDb({ dbPath: replacementPath });
  const rebuiltDb = openHealthyTarget(settings, replacementPath);
  let salvagedBlobs = 0;
  try {
    if (quarantinePath != null) {
      const salvageSource = openSqliteForSalvage({
        dbPath: quarantinePath,
        busyTimeoutMs: settings.busyTimeoutMs,
      });
      if (salvageSource == null && existsSync(quarantinePath)) {
        throw new ConversationBlobRecoveryError(
          "SLATE_BLOB_RECOVERY_QUARANTINE_UNREADABLE",
          "quarantined conversation blob database is unreadable",
        );
      }
      if (salvageSource != null) {
        try {
          salvagedBlobs = copySalvageableSqliteRows(
            salvageSource,
            "SELECT id, data FROM blobs",
            rebuiltDb.prepare("INSERT OR IGNORE INTO blobs (id, data) VALUES (?, ?)"),
            (row: unknown) => {
              const value = row as { id: string; data: unknown };
              return [value.id, value.data];
            },
          );
        } finally {
          try {
            salvageSource.close();
          } catch {
            // Preserve the salvage result.
          }
        }
      }
    }
    rebuiltDb.exec(`PRAGMA user_version = ${CONVERSATION_BLOB_RECOVERY_REBUILT}`);
    rebuiltDb.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    rebuiltDb.exec("PRAGMA journal_mode = DELETE");
  } finally {
    try {
      rebuiltDb.close();
    } catch {
      // Preserve the recovery error.
    }
  }
  removeSqliteSidecars(replacementPath);
  removeSqliteDb({
    dbPath: settings.dbPath,
    attempts: Math.ceil(settings.busyTimeoutMs / 50),
    retryDelayMs: 50,
  });
  renameSync(replacementPath, settings.dbPath);
  const installedConnection = openConfiguredConversationBlobDb(settings.dbPath, settings.busyTimeoutMs);
  if (healthOf(installedConnection) !== "healthy") {
    installedConnection.close();
    throw new ConversationBlobRecoveryError(
      "SLATE_BLOB_RECOVERY_INSTALL_UNHEALTHY",
      "installed conversation blob recovery is unhealthy",
    );
  }
  const recoveryInfo: RecoveryOutcome = {
    outcome: salvagedBlobs > 0 ? "recovered" : "reset",
    quarantinePath,
    salvagedBlobs,
  };
  settings.log?.(
    `[agent-store-worker] conversation-blobs.db recovery: outcome=${recoveryInfo.outcome} agent=${settings.agentId} quarantine=${recoveryInfo.quarantinePath != null ? basename(recoveryInfo.quarantinePath) : "none"} salvaged.blobs=${recoveryInfo.salvagedBlobs}`,
  );
  try {
    settings.onRecovery?.(recoveryInfo);
  } catch {
    // Recovery callback failures do not invalidate the installed database.
  }
  if (pendingPath != null) rmSync(pendingPath, { force: true });
  return installedConnection;
}

function locatePendingRecovery(dbPath: string): PendingRecovery | undefined {
  const dir = dirname(dbPath);
  const dbName = basename(dbPath);
  const prefix = `${dbName}.corrupt-`;
  const entries = readdirSync(dir);
  const quarantineMarkerNames = entries
    .filter((name) => name.startsWith(prefix) && (name.endsWith(".intent") || name.endsWith(".pending")))
    .sort();
  const inPlaceMarkerName = `${dbName}.pending`;
  const markerEntries = [
    ...(entries.includes(inPlaceMarkerName) ? [inPlaceMarkerName] : []),
    ...quarantineMarkerNames,
  ];
  const latestMarker = markerEntries.at(-1);
  const quarantinePathFor = (name: string): string => {
    const markerPath = join(dir, name);
    if (name === `${dbName}.pending`) return dbPath;
    const suffix = name.endsWith(".intent") ? ".intent" : ".pending";
    return markerPath.slice(0, -suffix.length);
  };
  const activeReplacement = latestMarker == null ? null : `${quarantinePathFor(latestMarker)}.replacement`;
  for (const name of entries) {
    if ((name.startsWith(prefix) || name === `${dbName}.replacement`) && name.endsWith(".replacement")) {
      const replacementPath = join(dir, name);
      if (replacementPath !== activeReplacement) removeSqliteDb({ dbPath: replacementPath });
    }
  }
  if (latestMarker == null) return undefined;
  for (const staleName of markerEntries.slice(0, -1)) {
    rmSync(join(dir, staleName), { force: true });
    removeSqliteDb({ dbPath: `${quarantinePathFor(staleName)}.replacement` });
  }
  const pendingPath = join(dir, latestMarker);
  return {
    pendingPath,
    quarantinePath: quarantinePathFor(latestMarker),
  };
}

export function openConversationBlobDb(settings: BlobDbSettings): DatabaseSync {
  mkdirSync(dirname(settings.dbPath), { recursive: true });
  const foundPending = locatePendingRecovery(settings.dbPath);
  if (foundPending != null) {
    return completeRecovery({
      settings,
      quarantinePath: foundPending.quarantinePath,
      pendingPath: foundPending.pendingPath,
    });
  }
  let connection: DatabaseSync;
  try {
    connection = openConfiguredConversationBlobDb(settings.dbPath, settings.busyTimeoutMs);
  } catch (error) {
    if (isSqliteIoError(error) || isSqliteCantOpenError(error)) {
      removeSqliteSidecars(settings.dbPath);
      try {
        connection = openConfiguredConversationBlobDb(settings.dbPath, settings.busyTimeoutMs);
      } catch (retryError) {
        if (isSqliteCorruptError(retryError)) return recoverConversationBlobDb(settings);
        throw retryError;
      }
    } else if (isSqliteCorruptError(error)) {
      return recoverConversationBlobDb(settings);
    } else {
      throw error;
    }
  }
  let condition: "healthy" | "corrupt";
  try {
    condition = runQuickCheck(connection);
  } catch (error) {
    try {
      connection.close();
    } catch {
      // Continue with the classified condition failure.
    }
    if (isSqliteIoError(error) || isSqliteCantOpenError(error)) {
      removeSqliteSidecars(settings.dbPath);
      try {
        connection = openConfiguredConversationBlobDb(settings.dbPath, settings.busyTimeoutMs);
        condition = runQuickCheck(connection);
      } catch (retryError) {
        if (isSqliteIoError(retryError) || isSqliteCantOpenError(retryError) || isSqliteCorruptError(retryError)) {
          return recoverConversationBlobDb(settings);
        }
        throw retryError;
      }
    } else if (isSqliteCorruptError(error)) {
      return recoverConversationBlobDb(settings);
    } else {
      throw new ConversationBlobRecoveryError(
        "SLATE_BLOB_RECOVERY_SOURCE_UNAVAILABLE",
        "conversation blob database health check is temporarily unavailable",
      );
    }
  }
  if (condition === "healthy") return connection;
  try {
    connection.close();
  } catch {
    // Continue recovery using the quarantined source.
  }
  return recoverConversationBlobDb(settings);
}
