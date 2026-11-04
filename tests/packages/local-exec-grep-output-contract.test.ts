import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createContext } from "../../source/packages/context/context.ts";
import {
  parseGrepContentOutput,
  parseGrepCountOutput,
  parseGrepFilesOutput,
  splitGrepLines,
} from "../../source/packages/local-exec/grep-output.ts";

describe("ripgrep output projection", () => {
  it("normalizes line endings and keeps a trailing empty row for callers to decide about", () => {
    assert.deepEqual(splitGrepLines("one\r\ntwo\rthree\n"), ["one", "two", "three", ""]);
  });

  it("counts files from valid rows and keeps the client and ripgrep cutoffs separate", () => {
    assert.deepEqual(parseGrepFilesOutput("a.ts\nb.ts\nc.ts\n", 2, 10), {
      files: ["a.ts", "b.ts"],
      totalFiles: 3,
      clientTruncated: true,
      ripgrepTruncated: false,
    });
    assert.equal(parseGrepFilesOutput("a.ts\nb.ts", 10, 2).ripgrepTruncated, true);
  });

  it("splits counts at the final colon, skips malformed rows, and totals before slicing", () => {
    const parsed = parseGrepCountOutput("C:\\work:results.ts:3\nbad row\n:5\nlast.ts:2tail\n", 1, 10);
    assert.deepEqual(parsed, {
      counts: [{ file: "C:\\work:results.ts", count: 3 }],
      totalFiles: 2,
      totalMatches: 5,
      clientTruncated: true,
      ripgrepTruncated: false,
    });
  });

  it("collects totals beyond the client cap and keeps context rows distinct", () => {
    const separator = String.fromCharCode(0);
    const output = [
      `a.ts${separator}12:match one`,
      `a.ts${separator}13-context row`,
      "--",
      `b.ts${separator}1:match two`,
      "invalid row",
      "",
    ].join("\n");
    const parsed = parseGrepContentOutput(output, 1, 4, createContext());
    assert.equal(parsed.totalLines, 5);
    assert.equal(parsed.totalMatchedLines, 2);
    assert.equal(parsed.totalFiles, 2);
    assert.equal(parsed.clientTruncated, true);
    assert.equal(parsed.ripgrepTruncated, true);
    assert.deepEqual(parsed.byFile.get("a.ts")?.matches, [{ lineNumber: 12, content: "match one", isContextLine: false }]);
  });
});
