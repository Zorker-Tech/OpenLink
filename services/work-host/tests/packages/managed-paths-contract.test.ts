import assert from "node:assert/strict";
import { test } from "node:test";

import {
  extractTerminalId,
  isAbsolutePath,
  isAgentToolOutputFile,
  isAgentTranscriptPath,
  isTerminalFilePath,
  isTerminalsDirectory,
  MANAGED_PROJECTS_SEGMENT,
  sanitizeFilename,
} from "../../source/packages/utils/managed-paths.ts";

test("managed workspace paths are recognized by directory shape, not substring", () => {
  const base = "/repo/.slate/projects/workspace-a";
  assert.equal(MANAGED_PROJECTS_SEGMENT, ".slate/projects");
  assert.equal(isAgentTranscriptPath(`${base}/agent-transcripts/session.json`), true);
  assert.equal(isAgentTranscriptPath("/repo/not-slate/projects/workspace-a/agent-transcripts/session.json"), false);
  assert.equal(isTerminalsDirectory(`${base}/terminals`), true);
  assert.equal(isTerminalsDirectory(`${base}/terminals/1.txt`), false);
  assert.equal(isAgentToolOutputFile(`${base}/agent-tools/out.txt`), true);
  assert.equal(isAgentToolOutputFile(`${base}/agent-tools/nested/out.txt`), false);
});

test("terminal identifiers require one numeric text file under the managed directory", () => {
  const prefix = "/repo/.slate/projects/workspace-a/terminals/";
  assert.deepEqual(extractTerminalId(`${prefix}0012.txt`), { id: 12 });
  assert.equal(extractTerminalId(`${prefix}abc.txt`), null);
  assert.equal(extractTerminalId(`${prefix}12.txt/extra`), null);
  assert.equal(isTerminalFilePath(`${prefix}12.txt`), true);
});

test("absolute paths and filenames follow cross-platform boundaries", () => {
  assert.equal(isAbsolutePath("/tmp/file"), true);
  assert.equal(isAbsolutePath("C:\\Temp\\file"), true);
  assert.equal(isAbsolutePath("\\\\server\\share\\file"), true);
  assert.equal(isAbsolutePath("relative/file"), false);
  assert.equal(sanitizeFilename("a b/c.txt"), "a_b_c.txt");
});
