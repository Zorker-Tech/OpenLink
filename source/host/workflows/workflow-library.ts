/** Public entry for the shared library of user-created workflows. */

import { rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { createDebouncePolicy, realClock } from "../extensions/scheduling.ts";
import {
  LEGACY_WORKFLOW_FILENAME,
  WORKFLOW_MAX_PER_AGENT,
  clampWorkflowBody,
  clampWorkflowDescription,
  clampWorkflowName,
} from "../../shared/workflow-model.ts";
import type { WorkflowSpec } from "../../shared/workflow-model.ts";
import { isSafeFolderId } from "../storage/folder-id.ts";
import { WatchedDirectory } from "../watched-directory.ts";
import { WORKFLOW_CHANGE_DEBOUNCE_MS, type GlobalWorkflowRecord } from "./workflow-library-contracts.ts";
import { listWorkflowFolderIds, listWorkflowHelperFiles, workflowFilePath, workflowFolderPath } from "./workflow-library-paths.ts";
import { readGlobalWorkflowRecord } from "./workflow-library-read.ts";
import { writeGlobalWorkflowRecord } from "./workflow-library-write.ts";
import { renameLegacyWorkflowFiles } from "./workflow-library-migration.ts";
import { nextWorkflowFolderId } from "./workflow-library-identifiers.ts";

export { WORKFLOW_CHANGE_DEBOUNCE_MS, type GlobalWorkflowRecord } from "./workflow-library-contracts.ts";
export { getGlobalWorkflowsDir } from "./workflow-library-paths.ts";

/** Manage the shared folder of reusable workflow definitions beside agent state. */
export class GlobalWorkflowLibrary {
  readonly dir: WatchedDirectory;

  constructor(readonly libraryDir: string) {
    this.dir = new WatchedDirectory(
      libraryDir,
      createDebouncePolicy(realClock, { name: "slate-workflow-library-change", delayMs: WORKFLOW_CHANGE_DEBOUNCE_MS }),
    );
    this.renameLegacyRecipeFiles();
  }

  renameLegacyRecipeFiles(): void {
    renameLegacyWorkflowFiles({
      listIds: () => this.listIds(),
      legacyPath: (id) => join(this.folder(id), LEGACY_WORKFLOW_FILENAME),
      currentPath: (id) => this.path(id),
    });
  }

  getLocation(): string {
    return this.libraryDir;
  }

  setOnChange(onChange?: (() => void) | null): void {
    this.dir.setOnChange(onChange);
  }

  folder(id: string): string {
    return workflowFolderPath(this.libraryDir, id);
  }

  path(id: string): string {
    return workflowFilePath(this.libraryDir, id);
  }

  listIds(): string[] {
    return listWorkflowFolderIds(this.libraryDir);
  }

  listHelperScripts(id: string): string[] {
    return listWorkflowHelperFiles(this.folder(id));
  }

  get(id: string): GlobalWorkflowRecord | null {
    if (!isSafeFolderId(id)) return null;
    const folderPath = this.folder(id);
    return readGlobalWorkflowRecord({
      id,
      definitionPath: this.path(id),
      folderPath,
      helperFiles: this.listHelperScripts(id),
    });
  }

  has(id: string): boolean {
    return this.get(id) != null;
  }

  list(): GlobalWorkflowRecord[] {
    return this.listIds()
      .flatMap((id) => {
        const record = this.get(id);
        return record == null ? [] : [record];
      })
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  count(): number {
    return this.listIds().filter((id) => this.get(id) != null).length;
  }

  uniqueId(name: string): string {
    return nextWorkflowFolderId(name, this.listIds());
  }

  create(spec: WorkflowSpec): GlobalWorkflowRecord | null {
    const name = clampWorkflowName(spec.name);
    const body = clampWorkflowBody(spec.body);
    if (!name || !body || this.count() >= WORKFLOW_MAX_PER_AGENT) return null;

    const id = this.uniqueId(name);
    return this.#write(id, {
      name,
      description: clampWorkflowDescription(spec.description),
      body,
      trigger: null,
      sourceRef: spec.sourceRef ?? null,
    });
  }

  update(id: string, spec: WorkflowSpec): GlobalWorkflowRecord | null {
    if (!isSafeFolderId(id) || this.get(id) == null) return null;
    const name = clampWorkflowName(spec.name);
    const body = clampWorkflowBody(spec.body);
    if (!name || !body) return null;

    return this.#write(id, {
      name,
      description: clampWorkflowDescription(spec.description),
      body,
      trigger: null,
      sourceRef: spec.sourceRef ?? null,
    });
  }

  writeAt(id: string, spec: WorkflowSpec): GlobalWorkflowRecord | null {
    if (!isSafeFolderId(id)) return null;
    return this.#write(id, { ...spec, trigger: null });
  }

  remove(id: string): boolean {
    if (!isSafeFolderId(id)) return false;
    const folderPath = this.folder(id);
    try {
      if (!statSync(folderPath).isDirectory()) return false;
    } catch {
      return false;
    }
    rmSync(folderPath, { recursive: true, force: true });
    this.dir.scheduleNotify();
    return true;
  }

  #write(id: string, spec: WorkflowSpec): GlobalWorkflowRecord | null {
    writeGlobalWorkflowRecord(this.dir, this.path(id), spec);
    return this.get(id);
  }
}
