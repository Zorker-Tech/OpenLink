import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  LOCAL_TOOL_APPROVALS_FILENAME,
  LOCAL_TOOL_RETIREMENTS_FILENAME,
  clearLocalToolApprovals,
  getLocalToolApprovalsPath,
  getLocalToolRetirementsPath,
  parseApproval,
  readLiveLocalToolApprovals,
  readLocalToolApprovals,
  recordLocalToolApproval,
  retireLocalToolApproval,
  type LocalToolApproval,
} from "../../source/host/local-exec/local-tool-approvals.ts";

const scratch = mkdtempSync(join(tmpdir(), "slate-local-tool-approvals-"));
after(() => { rmSync(scratch, { recursive: true, force: true }); });

function file(name: string): string {
  return join(scratch, name, LOCAL_TOOL_APPROVALS_FILENAME);
}

const approval = (id: string, target = `target-${id}`): LocalToolApproval => ({ id, action: "run-command", target });

describe("local tool approval records", () => {
  it("keeps the public files under Slate's own host root", () => {
    assert.equal(LOCAL_TOOL_APPROVALS_FILENAME, "local-tool-approvals.json");
    assert.equal(LOCAL_TOOL_RETIREMENTS_FILENAME, "local-tool-retirements.json");
    assert.match(getLocalToolApprovalsPath(), /\/\.slate\//);
    assert.match(getLocalToolRetirementsPath(), /\/\.slate\//);
    assert.ok(getLocalToolApprovalsPath().endsWith(LOCAL_TOOL_APPROVALS_FILENAME));
    assert.ok(getLocalToolRetirementsPath().endsWith(LOCAL_TOOL_RETIREMENTS_FILENAME));
  });

  it("accepts only records with a known action, non-empty id, and string target", () => {
    assert.deepEqual(parseApproval({ id: "a1", action: "write-file", target: "note.txt", resourcePath: "/work" }), {
      id: "a1", action: "write-file", target: "note.txt", resourcePath: "/work",
    });
    assert.deepEqual(parseApproval({ id: "a2", action: "read-file", target: "", resourcePath: 7 }), {
      id: "a2", action: "read-file", target: "",
    });
    for (const invalid of [null, [], "record", {}, { id: "", action: "run-command", target: "x" },
      { id: "a", action: "unknown", target: "x" }, { id: "a", action: "run-command", target: 1 }]) {
      assert.equal(parseApproval(invalid), undefined);
    }
  });

  it("skips malformed persisted entries, keeps the last duplicate, and treats broken files as empty", async () => {
    const path = file("parse");
    mkdirSync(join(scratch, "parse"), { recursive: true });
    writeFileSync(path, JSON.stringify({ approvals: [
      { id: "a", action: "run-command", target: "first" },
      { id: "bad", action: "not-an-action", target: "ignored" },
      { id: "b", action: "read-file", target: "file.txt" },
      { id: "a", action: "write-file", target: "last", resourcePath: "/work" },
    ] }));
    assert.deepEqual([...await readLocalToolApprovals(path)], [
      ["a", { id: "a", action: "write-file", target: "last", resourcePath: "/work" }],
      ["b", { id: "b", action: "read-file", target: "file.txt" }],
    ]);

    writeFileSync(path, "not json");
    assert.equal((await readLocalToolApprovals(path)).size, 0);
    writeFileSync(path, JSON.stringify({ approvals: "not a list" }));
    assert.equal((await readLocalToolApprovals(path)).size, 0);
  });

  it("serializes concurrent records, replaces by id without reordering, and writes nested paths atomically", async () => {
    const path = file("nested");
    await Promise.all([
      recordLocalToolApproval(approval("a"), path),
      recordLocalToolApproval(approval("b"), path),
    ]);
    await recordLocalToolApproval({ ...approval("a", "updated"), resourcePath: "/workspace" }, path);

    assert.deepEqual([...await readLocalToolApprovals(path)], [
      ["a", { ...approval("a", "updated"), resourcePath: "/workspace" }],
      ["b", approval("b")],
    ]);
    assert.deepEqual(readdirSync(join(scratch, "nested")), [LOCAL_TOOL_APPROVALS_FILENAME]);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
      approvals: [{ ...approval("a", "updated"), resourcePath: "/workspace" }, approval("b")],
    });
  });

  it("orders clear behind earlier writes and removes the empty approvals file", async () => {
    const path = file("clear-after-write");
    await Promise.all([
      recordLocalToolApproval(approval("a"), path),
      clearLocalToolApprovals(path),
    ]);
    assert.equal(existsSync(path), false);
    assert.equal((await readLocalToolApprovals(path)).size, 0);
  });

  it("keeps retirement tombstones only for approvals that still exist", async () => {
    const approvalsPath = file("retirement");
    const retirementsPath = join(scratch, "retirement", LOCAL_TOOL_RETIREMENTS_FILENAME);
    mkdirSync(join(scratch, "retirement"), { recursive: true });
    writeFileSync(approvalsPath, JSON.stringify({ approvals: [approval("a"), approval("b")] }));
    writeFileSync(retirementsPath, JSON.stringify({ retiredIds: ["b", "stale", 9] }));

    const live = await readLiveLocalToolApprovals(approvalsPath, retirementsPath);
    assert.deepEqual([...live], [["a", approval("a")]]);
    assert.deepEqual([...await readLocalToolApprovals(approvalsPath)], [["a", approval("a")], ["b", approval("b")]]);

    await retireLocalToolApproval("a", approvalsPath, retirementsPath);
    assert.deepEqual(JSON.parse(readFileSync(retirementsPath, "utf8")), { retiredIds: ["b", "a"] });
    assert.equal((await readLiveLocalToolApprovals(approvalsPath, retirementsPath)).size, 0);
  });

  it("does not persist a retirement for an unknown id and removes an empty retirement list", async () => {
    const approvalsPath = file("unknown-retirement");
    const retirementsPath = join(scratch, "unknown-retirement", LOCAL_TOOL_RETIREMENTS_FILENAME);
    mkdirSync(join(scratch, "unknown-retirement"), { recursive: true });
    writeFileSync(approvalsPath, JSON.stringify({ approvals: [approval("a")] }));

    await retireLocalToolApproval("missing", approvalsPath, retirementsPath);
    assert.equal(existsSync(retirementsPath), false);

    await retireLocalToolApproval("a", approvalsPath, retirementsPath);
    assert.deepEqual(JSON.parse(readFileSync(retirementsPath, "utf8")), { retiredIds: ["a"] });
    await retireLocalToolApproval("a", approvalsPath, retirementsPath);
    assert.deepEqual(JSON.parse(readFileSync(retirementsPath, "utf8")), { retiredIds: ["a"] });
  });

  it("serializes concurrent retirements so neither live approval is lost early", async () => {
    const approvalsPath = file("concurrent-retirement");
    const retirementsPath = join(scratch, "concurrent-retirement", LOCAL_TOOL_RETIREMENTS_FILENAME);
    mkdirSync(join(scratch, "concurrent-retirement"), { recursive: true });
    writeFileSync(approvalsPath, JSON.stringify({ approvals: [approval("a"), approval("b")] }));

    await Promise.all([
      retireLocalToolApproval("a", approvalsPath, retirementsPath),
      retireLocalToolApproval("b", approvalsPath, retirementsPath),
    ]);
    assert.deepEqual(JSON.parse(readFileSync(retirementsPath, "utf8")), { retiredIds: ["a", "b"] });
    assert.equal((await readLiveLocalToolApprovals(approvalsPath, retirementsPath)).size, 0);
  });
});
