import { renameSync, statSync } from "node:fs";

/** Promote a legacy file only when it is a file and the new workflow definition is absent. */
export function renameLegacyWorkflowFiles(args: {
  readonly listIds: () => string[];
  readonly legacyPath: (id: string) => string;
  readonly currentPath: (id: string) => string;
}): void {
  for (const id of args.listIds()) {
    const legacyFile = args.legacyPath(id);
    try {
      if (!statSync(legacyFile).isFile()) continue;
    } catch {
      continue;
    }

    const currentFile = args.currentPath(id);
    try {
      statSync(currentFile);
      continue;
    } catch {
      // The migration target does not exist yet.
    }

    try {
      renameSync(legacyFile, currentFile);
    } catch {
      // A failed migration leaves the original definition available for a later pass.
    }
  }
}
