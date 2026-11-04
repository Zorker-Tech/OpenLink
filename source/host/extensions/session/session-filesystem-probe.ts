import { stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { basename, dirname } from "node:path";
import { reportSessionDiagnostic } from "./session-diagnostics.ts";

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

export async function inspectPathIfPresent(path: string): Promise<Stats | undefined> {
  try {
    return await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      reportSessionDiagnostic({
        family: "store_db",
        kind: "path_stat_failed",
        agentId: basename(dirname(path)),
        errorClass: errorKind(error),
      });
    }
    return undefined;
  }
}
