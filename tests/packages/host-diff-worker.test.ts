import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { calculateDiff } from "../../source/packages/agent/tools/core/edit/diff-worker.ts";

describe("the diff a file edit produced", () => {
  it("is empty when the text did not change", () => {
    assert.deepEqual(calculateDiff({ original: "a\n", new: "a\n" }), { diffString: "", linesAdded: 0, linesRemoved: 0 });
    assert.deepEqual(calculateDiff({ original: "", new: "" }), { diffString: "", linesAdded: 0, linesRemoved: 0 });
  });

  it("adds a whole file when there was nothing before, without claiming a line was removed", () => {
    const added = calculateDiff({ original: "", new: "x\n", filePath: "f.ts" });
    assert.equal(added.linesAdded, 1);
    assert.equal(added.linesRemoved, 0, "an empty original is no line at all, not one empty line");
  });

  it("treats a missing trailing newline as no change at all", () => {
    assert.equal(calculateDiff({ original: "a", new: "a" }).diffString, "");
    assert.equal(calculateDiff({ original: "a", new: "a\n" }).diffString, "");
  });

  it("names both sides, and counts what it added and removed", () => {
    const diff = calculateDiff({ original: "a\nb\nc\n", new: "a\nB\nc\n", filePath: " src/x.ts " });
    const lines = diff.diffString.split("\n");
    assert.equal(lines[0], "--- a/src/x.ts");
    assert.equal(lines[1], "+++ b/src/x.ts");
    assert.match(lines[2] ?? "", /^@@ -\d+(,\d+)? \+\d+(,\d+)? @@$/);
    assert.equal(diff.linesAdded, 1);
    assert.equal(diff.linesRemoved, 1);
    assert.equal(lines.some((line) => line.startsWith("+B")), true);
  });

  it("names the side that does not exist as /dev/null, for an added file and a deleted one", () => {
    const added = calculateDiff({ original: "", new: "new\n", filePath: "n.txt", fileChangeType: "added" });
    assert.equal(added.diffString.split("\n")[0], "--- /dev/null");
    assert.equal(added.diffString.split("\n")[1], "+++ b/n.txt");
    const deleted = calculateDiff({ original: "old\n", new: "", filePath: "n.txt", fileChangeType: "deleted" });
    assert.equal(deleted.diffString.split("\n")[0], "--- a/n.txt");
    assert.equal(deleted.diffString.split("\n")[1], "+++ /dev/null");
  });

  it("writes a range the way git does: bare for one line, and with its zero for none", () => {
    const oneLine = calculateDiff({ original: "a\n", new: "b\n", filePath: "f.ts" }).diffString.split("\n")[2];
    assert.equal(oneLine, "@@ -1 +1 @@");
    // The library reports the old side starting at one with no lines, which is what this build writes out.
    const fromNothing = calculateDiff({ original: "", new: "x\n", filePath: "f.ts" }).diffString.split("\n")[2];
    assert.equal(fromNothing, "@@ -1,0 +1 @@");
  });

  it("calls the file by a plain name when it was not told one", () => {
    assert.equal(calculateDiff({ original: "a\n", new: "b\n" }).diffString.split("\n")[0], "--- a/file");
    assert.equal(calculateDiff({ original: "a\n", new: "b\n", filePath: "   " }).diffString.split("\n")[0], "--- a/file");
  });

  it("carries three lines of context either side of a change", () => {
    const original = Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n");
    const changed = Array.from({ length: 20 }, (_, index) => `line ${index === 10 ? "changed" : index}`).join("\n");
    const lines = calculateDiff({ original, new: changed, filePath: "f.ts" }).diffString.split("\n");
    // Everything after the hunk's own `@@` line is its body: three lines of context, the change, three more.
    const body = lines.slice(lines.findIndex((line) => line.startsWith("@@")) + 1);
    assert.deepEqual(body, [" line 7", " line 8", " line 9", "-line 10", "+line changed", " line 11", " line 12", " line 13"]);
  });
});
