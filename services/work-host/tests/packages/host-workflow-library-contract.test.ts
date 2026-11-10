import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  GlobalWorkflowLibrary,
  WORKFLOW_CHANGE_DEBOUNCE_MS,
  getGlobalWorkflowsDir,
} from "../../source/host/workflows/workflow-library.ts";
import {
  LEGACY_WORKFLOW_FILENAME,
  WORKFLOW_FILENAME,
  WORKFLOW_MAX_PER_AGENT,
  parseWorkflowFile,
} from "../../source/shared/workflow-model.ts";
import type { WorkflowSpec } from "../../source/shared/workflow-model.ts";

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length > 0) cleanups.pop()?.(); });

function libraryWorld() {
  const root = mkdtempSync(join(tmpdir(), "slate-workflow-library-contract-"));
  const libraryDir = join(root, "workflows");
  mkdirSync(libraryDir, { recursive: true });
  const library = new GlobalWorkflowLibrary(libraryDir);
  cleanups.push(() => {
    library.dir.stopWatching();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, libraryDir, library };
}

function spec(name: string, overrides: Partial<WorkflowSpec> = {}): WorkflowSpec {
  return {
    name,
    description: `About ${name}`,
    body: `Do ${name}`,
    trigger: { schedule: "0 9 * * 1-5", isEnabled: true },
    ...overrides,
  };
}

function writeRecord(libraryDir: string, id: string, contents: string): string {
  const folder = join(libraryDir, id);
  mkdirSync(folder, { recursive: true });
  const path = join(folder, WORKFLOW_FILENAME);
  writeFileSync(path, contents, "utf8");
  return path;
}

describe("the global workflow library contract", () => {
  it("uses one shared workflow folder and a declared change debounce", () => {
    const world = libraryWorld();
    assert.equal(getGlobalWorkflowsDir(world.root), world.libraryDir);
    assert.equal(world.library.getLocation(), world.libraryDir);
    assert.equal(WORKFLOW_CHANGE_DEBOUNCE_MS, 50);
  });

  it("lists existing folders in sorted order and ignores files at the library root", () => {
    const world = libraryWorld();
    mkdirSync(join(world.libraryDir, "zulu"));
    mkdirSync(join(world.libraryDir, "alpha"));
    writeFileSync(join(world.libraryDir, "readme.md"), "not a workflow folder", "utf8");
    assert.deepEqual(world.library.listIds(), ["alpha", "zulu"]);
  });

  it("moves a legacy workflow file only when the new file is absent", () => {
    const root = mkdtempSync(join(tmpdir(), "slate-workflow-legacy-contract-"));
    const libraryDir = join(root, "workflows");
    const legacyOnly = join(libraryDir, "legacy-only");
    const bothFormats = join(libraryDir, "both-formats");
    const legacyDirectory = join(libraryDir, "legacy-directory");
    mkdirSync(legacyOnly, { recursive: true });
    mkdirSync(bothFormats, { recursive: true });
    mkdirSync(join(legacyDirectory, LEGACY_WORKFLOW_FILENAME), { recursive: true });
    writeFileSync(join(legacyOnly, LEGACY_WORKFLOW_FILENAME), "---\nname: Legacy only\n---\nOld body\n", "utf8");
    writeFileSync(join(bothFormats, LEGACY_WORKFLOW_FILENAME), "old", "utf8");
    writeFileSync(join(bothFormats, WORKFLOW_FILENAME), "---\nname: Current\n---\nCurrent body\n", "utf8");
    const library = new GlobalWorkflowLibrary(libraryDir);
    cleanups.push(() => { library.dir.stopWatching(); rmSync(root, { recursive: true, force: true }); });

    assert.equal(existsSync(join(legacyOnly, LEGACY_WORKFLOW_FILENAME)), false);
    assert.equal(existsSync(join(legacyOnly, WORKFLOW_FILENAME)), true);
    assert.equal(existsSync(join(bothFormats, LEGACY_WORKFLOW_FILENAME)), true);
    assert.equal(library.get("legacy-only")?.name, "Legacy only");
    assert.equal(library.get("both-formats")?.name, "Current");
    assert.equal(library.listIds().includes("legacy-directory"), true);
  });

  it("returns sorted helper files without reserved files or child directories", () => {
    const world = libraryWorld();
    const folder = join(world.libraryDir, "with-helpers");
    mkdirSync(join(folder, "nested"), { recursive: true });
    for (const name of [WORKFLOW_FILENAME, LEGACY_WORKFLOW_FILENAME, "runs.json", "z.sh", "a.txt"]) {
      writeFileSync(join(folder, name), name, "utf8");
    }
    assert.deepEqual(world.library.listHelperScripts("with-helpers"), ["a.txt", "z.sh"]);
    assert.deepEqual(world.library.listHelperScripts("missing"), []);
  });

  it("refuses unsafe or absent ids and treats unclosed frontmatter as plain markdown", () => {
    const world = libraryWorld();
    assert.equal(world.library.get("../outside"), null);
    assert.equal(world.library.get("nested/id"), null);
    assert.equal(world.library.get("missing"), null);
    writeRecord(world.libraryDir, "broken", "---\nname: broken\nmissing close");
    writeRecord(world.libraryDir, "empty", "---\nname: empty\n---\n");
    assert.deepEqual([world.library.get("broken")?.name, world.library.get("broken")?.body], [
      "broken",
      "---\nname: broken\nmissing close",
    ]);
    assert.equal(world.library.get("empty"), null);
    assert.equal(world.library.has("broken"), true);
  });

  it("projects a valid file and its helper scripts into one library record", () => {
    const world = libraryWorld();
    const filePath = writeRecord(world.libraryDir, "playbook", "---\nname: Playbook\ndescription: Steps\nmetadata:\n  source: https://example.test/runbook\n---\nDo the work\n");
    writeFileSync(join(world.libraryDir, "playbook", "helper.sh"), "echo ready", "utf8");
    const record = world.library.get("playbook");
    assert.deepEqual(record && {
      id: record.id,
      name: record.name,
      description: record.description,
      body: record.body,
      suggestedTrigger: record.suggestedTrigger,
      sourceRef: record.sourceRef,
      helperScripts: record.helperScripts,
      filePath: record.filePath,
    }, {
      id: "playbook",
      name: "Playbook",
      description: "Steps",
      body: "Do the work",
      suggestedTrigger: null,
      sourceRef: "https://example.test/runbook",
      helperScripts: ["helper.sh"],
      filePath,
    });
    assert.equal(typeof record?.createdAt, "number");
  });

  it("creates normalized records with unique folder ids and no schedule trigger", () => {
    const world = libraryWorld();
    const first = world.library.create(spec("Daily Review", { body: "  Check the work.  " }));
    const second = world.library.create(spec("Daily Review"));
    assert.ok(first);
    assert.ok(second);
    assert.deepEqual([first.id, second.id], ["daily-review", "daily-review-2"]);
    assert.deepEqual([first.name, first.body, first.description, first.suggestedTrigger, first.sourceRef], [
      "Daily Review", "Check the work.", "About Daily Review", null, null,
    ]);
    assert.equal(world.library.get(first.id)?.filePath, first.filePath);
    assert.equal(world.library.count(), 2);
  });

  it("chooses the next id around existing folders even if their records do not parse", () => {
    const world = libraryWorld();
    mkdirSync(join(world.libraryDir, "daily-review"));
    writeFileSync(join(world.libraryDir, "daily-review", WORKFLOW_FILENAME), "broken", "utf8");
    assert.equal(world.library.uniqueId("Daily Review"), "daily-review-2");
  });

  it("refuses blank values and stops creation at the configured limit", () => {
    const world = libraryWorld();
    assert.equal(world.library.create(spec("   ")), null);
    assert.equal(world.library.create(spec("No body", { body: " \n " })), null);
    for (let index = 0; index < WORKFLOW_MAX_PER_AGENT; index += 1) {
      assert.ok(world.library.create(spec(`Workflow ${index}`)));
    }
    assert.equal(world.library.count(), WORKFLOW_MAX_PER_AGENT);
    assert.equal(world.library.create(spec("One too many")), null);
  });

  it("updates only an existing safe id and preserves unrecognized frontmatter", () => {
    const world = libraryWorld();
    const filePath = writeRecord(world.libraryDir, "existing", "---\nname: Old\ndescription: Old description\nsourceRef: old-ref\ncustom-field: keep\n---\nOld body\n");
    const updated = world.library.update("existing", spec("New name", { body: "New body", sourceRef: "new-ref" }));
    assert.deepEqual(updated && [updated.id, updated.name, updated.body, updated.sourceRef, updated.suggestedTrigger], [
      "existing", "New name", "New body", "new-ref", null,
    ]);
    assert.equal(parseWorkflowFile(readFileSync(filePath, "utf8"))?.data["custom-field"], "keep");
    assert.equal(world.library.update("missing", spec("Missing")), null);
    assert.equal(world.library.update("../outside", spec("Unsafe")), null);
    assert.equal(world.library.update("existing", spec(" ")), null);
  });

  it("writes a specified safe folder directly and clears its proposed schedule", () => {
    const world = libraryWorld();
    const written = world.library.writeAt("migration-id", spec("Migrated", {
      trigger: { schedule: "0 9 * * 1-5", isEnabled: true },
      sourceRef: "legacy-source",
    }));
    assert.deepEqual(written && [written.id, written.name, written.suggestedTrigger, written.sourceRef], [
      "migration-id", "Migrated", null, "legacy-source",
    ]);
    assert.equal(world.library.writeAt("../escape", spec("Unsafe")), null);
  });

  it("lists only readable records in oldest-first order and counts the same set", () => {
    const world = libraryWorld();
    world.library.create(spec("Zulu"));
    world.library.create(spec("Alpha"));
    writeRecord(world.libraryDir, "invalid", "");
    const records = world.library.list();
    assert.equal(records.length, 2);
    assert.equal(world.library.count(), 2);
    assert.deepEqual(records.map(({ id }) => id).sort(), ["alpha", "zulu"]);
    assert.ok(records[0]!.createdAt <= records[1]!.createdAt);
  });

  it("removes only a safe existing directory and leaves invalid ids untouched", () => {
    const world = libraryWorld();
    world.library.create(spec("Remove me"));
    assert.equal(world.library.remove("../outside"), false);
    assert.equal(world.library.remove("missing"), false);
    assert.equal(world.library.remove("remove-me"), true);
    assert.equal(world.library.get("remove-me"), null);
    assert.deepEqual(readdirSync(world.libraryDir), []);
  });

  it("can attach and detach a change callback", () => {
    const world = libraryWorld();
    world.library.setOnChange(() => {});
    world.library.setOnChange(null);
    world.library.dir.stopWatching();
  });
});
