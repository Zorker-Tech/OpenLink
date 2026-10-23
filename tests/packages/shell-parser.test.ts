/**
 * Reading a shell command well enough to decide whether it is safe to allow.
 *
 * What is pinned here is the analysis itself: the simple commands and executable commands read out of a parse, the
 * coarse redirect flags, every redirection operator and file-descriptor move, the null-device allowance and the order
 * the optional flag is appended in, heredocs and herestrings (including inside substitutions), command substitution,
 * invalid input, and the runtime-dependency loader: a staged stub build degrades to parsingFailed, a missing or broken
 * stage reports the domain it looked in, and the developer's own installation is used outside a packaged runtime.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { analyzeShellCommand, TREE_SITTER_STUBBED_ERROR_CODE } from "../../source/packages/shell-exec/shell-parser.ts";

const MODULE_PATH = join(import.meta.dirname, "../../source/packages/shell-exec/shell-parser.ts");
const BACKTICK = String.fromCharCode(96);

// ---------------------------------------------------------------------------------------------
// the analysis

test("a plain command is read into its simple and executable forms", () => {
  assert.deepEqual(analyzeShellCommand("ls -la /tmp"), {
    legacy: { simpleCommands: ["ls"], hasInputRedirect: false, hasOutputRedirect: false },
    structured: {
      parsingFailed: false,
      executableCommands: [{ name: "ls", args: [{ type: "word", value: "-la" }, { type: "word", value: "/tmp" }], fullText: "ls -la /tmp" }],
      hasRedirects: false,
      hasCommandSubstitution: false,
      redirects: [],
    },
  });
});

test("an empty command has nothing to read", () => {
  assert.deepEqual(analyzeShellCommand("   "), {
    legacy: { simpleCommands: [], hasInputRedirect: false, hasOutputRedirect: false },
    structured: { parsingFailed: false, executableCommands: [], hasRedirects: false, hasCommandSubstitution: false, redirects: [] },
  });
});

test("arguments keep the type the parser gave them", () => {
  const analysis = analyzeShellCommand('echo hi "a b" 0 $x $(ls)');
  assert.deepEqual(analysis.structured.executableCommands[0]?.args, [
    { type: "word", value: "hi" },
    { type: "string", value: '"a b"' },
    { type: "number", value: "0" },
    { type: "simple_expansion", value: "$x" },
    { type: "command_substitution", value: "$(ls)" },
  ]);
  assert.equal(analysis.structured.executableCommands[0]?.fullText, 'echo hi "a b" 0 $x $(ls)');
  // A command in a substitution is its own command.
  assert.deepEqual(analysis.legacy.simpleCommands, ["echo", "ls"]);
  assert.equal(analysis.structured.hasCommandSubstitution, true);
});

test("several statements are read in order, and lists and pipes add no flags", () => {
  assert.deepEqual(analyzeShellCommand("ls; cat <<EOF\nbody\nEOF\nls").legacy.simpleCommands, ["ls", "cat", "ls"]);
  const piped = analyzeShellCommand("echo hi | cat < in.txt > /dev/null");
  assert.deepEqual(piped.legacy.simpleCommands, ["echo", "cat"]);
  assert.equal(piped.legacy.hasInputRedirect, true);
  assert.equal(piped.legacy.hasOutputRedirect, true);
  assert.equal(piped.structured.hasRedirects, true);
  assert.deepEqual(piped.structured.redirects, [
    { operator: "<", destinationFds: [0], targetNodeType: "word", targetText: "in.txt" },
    { operator: ">", destinationFds: [1], targetNodeType: "word", targetText: "/dev/null" },
  ]);
  // An input redirect makes the set unsafe even when the output one is the null device.
  assert.equal(piped.structured.allRedirectsAreDevNull, false);
});

test("a file redirect records its operator, destinations and static target", () => {
  assert.deepEqual(analyzeShellCommand("echo hi >> out.txt").structured.redirects, [
    { operator: ">>", destinationFds: [1], targetNodeType: "word", targetText: "out.txt" },
  ]);
  assert.deepEqual(analyzeShellCommand("echo hi >| out.txt").structured.redirects, [
    { operator: ">|", destinationFds: [1], targetNodeType: "word", targetText: "out.txt" },
  ]);
  assert.deepEqual(analyzeShellCommand("cat < in.txt").structured.redirects, [
    { operator: "<", destinationFds: [0], targetNodeType: "word", targetText: "in.txt" },
  ]);
  assert.deepEqual(analyzeShellCommand("echo hi 2> err.txt").structured.redirects, [
    { operator: ">", destinationFds: [2], targetNodeType: "word", targetText: "err.txt" },
  ]);
  assert.deepEqual(analyzeShellCommand("echo hi 3> /dev/null").structured.redirects, [
    { operator: ">", destinationFds: [3], targetNodeType: "word", targetText: "/dev/null" },
  ]);
});

test("a redirect's static target is read however it is written, and a trailing comment is not one", () => {
  assert.deepEqual(analyzeShellCommand("echo hi > out.txt # trailing").structured.redirects, [
    { operator: ">", destinationFds: [1], targetNodeType: "word", targetText: "out.txt" },
  ]);
  assert.deepEqual(analyzeShellCommand('echo hi > "file name"').structured.redirects, [
    { operator: ">", destinationFds: [1], targetNodeType: "string", targetText: "file name" },
  ]);
  assert.deepEqual(analyzeShellCommand("echo hi > 'file name'").structured.redirects, [
    { operator: ">", destinationFds: [1], targetNodeType: "raw_string", targetText: "file name" },
  ]);
  // An expansion has no static text, so only its node type is recorded.
  assert.deepEqual(analyzeShellCommand("echo hi > $x").structured.redirects, [
    { operator: ">", destinationFds: [1], targetNodeType: "simple_expansion" },
  ]);
  // A quoted target that mixes text and an expansion is not static either.
  assert.deepEqual(analyzeShellCommand('echo hi > "a$b"').structured.redirects, [
    { operator: ">", destinationFds: [1], targetNodeType: "string" },
  ]);
});

test("the trail of one command's descriptors is shared between its redirects", () => {
  // The second descriptor move reads where the first one left file descriptor zero.
  const analysis = analyzeShellCommand("cat 0< /dev/null 1<&0");
  assert.deepEqual(analysis.structured.redirects, [
    { operator: "<", destinationFds: [0], targetNodeType: "word", targetText: "/dev/null" },
    { operator: "<&", destinationFds: [1], targetNodeType: "number", targetText: "0" },
  ]);
  assert.equal(analysis.structured.allRedirectsAreDevNull, true);
});

test("both streams of an &> redirect are moved together", () => {
  assert.deepEqual(analyzeShellCommand("echo hi &> both.txt").structured.redirects, [
    { operator: "&>", destinationFds: [1, 2], targetNodeType: "word", targetText: "both.txt" },
  ]);
  assert.deepEqual(analyzeShellCommand("echo hi &>> both.txt").structured.redirects, [
    { operator: "&>>", destinationFds: [1, 2], targetNodeType: "word", targetText: "both.txt" },
  ]);
});

test("a descriptor move is safe only when it points at an allowed stream", () => {
  const toStderr = analyzeShellCommand("echo hi 2>&1");
  assert.deepEqual(toStderr.structured.redirects, [{ operator: ">&", destinationFds: [2], targetNodeType: "number", targetText: "1" }]);
  assert.equal(toStderr.structured.allRedirectsAreDevNull, true);

  const after = analyzeShellCommand("echo hi 2>&1 > /dev/null");
  assert.deepEqual(after.structured.redirects, [
    { operator: ">&", destinationFds: [2], targetNodeType: "number", targetText: "1" },
    { operator: ">", destinationFds: [1], targetNodeType: "word", targetText: "/dev/null" },
  ]);
  assert.equal(after.structured.allRedirectsAreDevNull, true);

  const toOriginalStderr = analyzeShellCommand("echo hi 1>&2");
  assert.deepEqual(toOriginalStderr.structured.redirects, [{ operator: ">&", destinationFds: [1], targetNodeType: "number", targetText: "2" }]);
  assert.equal(toOriginalStderr.structured.allRedirectsAreDevNull, true);

  // The null device as a trail target can be moved onto another descriptor.
  const copiedNull = analyzeShellCommand("echo hi 2>/dev/null 1>&2");
  assert.deepEqual(copiedNull.structured.redirects, [
    { operator: ">", destinationFds: [2], targetNodeType: "word", targetText: "/dev/null" },
    { operator: ">&", destinationFds: [1], targetNodeType: "number", targetText: "2" },
  ]);
  assert.equal(copiedNull.structured.allRedirectsAreDevNull, true);

  // An input-side move is only allowed from the null device.
  const inputFromStderr = analyzeShellCommand("cat 1<&2");
  assert.equal(inputFromStderr.structured.allRedirectsAreDevNull, false);

  const inputSide = analyzeShellCommand("echo hi <&0");
  assert.deepEqual(inputSide.structured.redirects, [{ operator: "<&", destinationFds: [0], targetNodeType: "number", targetText: "0" }]);
  // The input side is not the null device, so it is not allowed.
  assert.equal(inputSide.structured.allRedirectsAreDevNull, false);
});

test("only the null device is allowed as a redirect target, in each way it can be written", () => {
  for (const command of ["echo hi > /dev/null", "echo hi >/dev/null", "echo hi > '/dev/null'", 'echo hi > "/dev/null"']) {
    assert.equal(analyzeShellCommand(command).structured.allRedirectsAreDevNull, true, command);
  }
  assert.equal(analyzeShellCommand("echo hi > /dev/zero").structured.allRedirectsAreDevNull, false);
});

test("the null-device flag is appended after the rest of the structured result", () => {
  assert.deepEqual(Object.keys(analyzeShellCommand("echo hi > /dev/null").structured), [
    "parsingFailed",
    "executableCommands",
    "hasRedirects",
    "hasCommandSubstitution",
    "redirects",
    "allRedirectsAreDevNull",
  ]);
  // Without a redirect at all the flag is absent.
  assert.deepEqual(Object.keys(analyzeShellCommand("echo hi").structured), [
    "parsingFailed",
    "executableCommands",
    "hasRedirects",
    "hasCommandSubstitution",
    "redirects",
  ]);
});

test("a heredoc read by a known command is allowed, with the receiver as its target", () => {
  const analysis = analyzeShellCommand("cat <<EOF\nhello\nEOF");
  assert.deepEqual(analysis.structured.redirects, [
    { operator: "<<", destinationFds: [0], targetNodeType: "heredoc_redirect", targetText: "cat" },
  ]);
  assert.equal(analysis.structured.allRedirectsAreDevNull, true);
  assert.equal(analysis.legacy.hasInputRedirect, true);
});

test("a heredoc inside an unquoted substitution is not allowed", () => {
  const analysis = analyzeShellCommand("echo $(cat <<EOF\nnested\nEOF\n)");
  assert.deepEqual(analysis.structured.redirects, [
    { operator: "", destinationFds: [], targetNodeType: "heredoc_redirect" },
  ]);
  assert.equal(analysis.structured.allRedirectsAreDevNull, false);
});

test("a herestring is reported but not allowed", () => {
  assert.deepEqual(analyzeShellCommand("cat <<< hello").structured.redirects, [
    { operator: "", destinationFds: [], targetNodeType: "herestring_redirect" },
  ]);
  assert.equal(analyzeShellCommand("cat <<< hello").legacy.hasInputRedirect, true);
});

test("command and process substitutions are both noticed", () => {
  for (const command of ["echo $(ls)", "echo " + BACKTICK + "date" + BACKTICK, "echo <(ls)", "echo >(cat)"]) {
    assert.equal(analyzeShellCommand(command).structured.hasCommandSubstitution, true, command);
  }
  assert.equal(analyzeShellCommand("echo hi").structured.hasCommandSubstitution, false);
});

test("a redirect inside a substitution is still classified", () => {
  const analysis = analyzeShellCommand("echo $(echo hi > out.txt)");
  assert.deepEqual(analysis.structured.redirects, [
    { operator: ">", destinationFds: [1], targetNodeType: "word", targetText: "out.txt" },
  ]);
  assert.equal(analysis.structured.allRedirectsAreDevNull, false);
});

test("input that cannot be read cleanly is still answered", () => {
  // An unterminated quote or bracket is a parse error, not a thrown analysis.
  const unterminated = analyzeShellCommand('echo "unterminated');
  assert.equal(unterminated.structured.parsingFailed, false);
  const bracket = analyzeShellCommand("(echo hi");
  assert.deepEqual(bracket.legacy.simpleCommands, ["echo"]);
});

test("the stubbed-native code is a constant a caller can compare", () => {
  assert.equal(TREE_SITTER_STUBBED_ERROR_CODE, "SLATE_TREE_SITTER_STUBBED");
});

// ---------------------------------------------------------------------------------------------
// the runtime-dependency loader

interface ChildReport {
  readonly status?: string;
  readonly stubCode?: string;
  readonly analysis?: { legacy?: { simpleCommands?: readonly string[] }; structured?: { parsingFailed?: boolean } };
  readonly message?: string;
  readonly code?: string;
  readonly dependency?: string;
  readonly domain?: string;
  readonly roots?: readonly string[];
  readonly causeMessage?: string;
}

const CHILD_SCRIPT = [
  'const modulePath = process.argv[1];',
  'const report = (value) => console.log(JSON.stringify(value));',
  'try {',
  '  const module = await import(modulePath);',
  '  report({ status: "loaded", stubCode: module.TREE_SITTER_STUBBED_ERROR_CODE, analysis: module.analyzeShellCommand("cat <<EOF\\nhello") });',
  '} catch (error) {',
  '  report({',
  '    status: "error",',
  '    message: error?.message,',
  '    code: error?.code,',
  '    dependency: error?.dependency,',
  '    domain: error?.domain,',
  '    roots: error?.roots,',
  '    causeMessage: error?.cause instanceof Error ? error.cause.message : undefined,',
  '  });',
  '}',
].join("\n");

function runChild(env: Record<string, string>): { report: ChildReport; stderr: string } {
  const result = spawnSync(process.execPath, ["--experimental-transform-types", "--no-warnings", "--input-type=module", "-e", CHILD_SCRIPT, MODULE_PATH], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  const line = result.stdout.split("\n").find((candidate) => candidate.startsWith("{"));
  return { report: line === undefined ? {} : JSON.parse(line) as ChildReport, stderr: result.stderr };
}

function withFixtures(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "slate-shell-parser-deps-"));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writePackage(root: string, name: string, source: string): void {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, "package.json"), JSON.stringify({ name, version: "0.0.0", main: "index.js" }));
  writeFileSync(join(root, name, "index.js"), source);
}

const STUB_PARSER = ["module.exports = class StubParser {", "  constructor() {", '    const error = new Error("stubbed native parser");', '    error.code = "SLATE_TREE_SITTER_STUBBED";', "    throw error;", "  }", "};"].join("\n");

test("the developer's own installation loads when the runtime is not packaged", () => {
  withFixtures((root) => {
    const { report } = runChild({ SLATE_TREE_SITTER_NODE_DEPS: "" });
    assert.equal(report.status, "loaded");
    assert.equal(report.analysis?.structured?.parsingFailed, false);
  });
});

test("a configured root is used by a developer runtime too, and fails when it is not staged", () => {
  withFixtures((root) => {
    const { report } = runChild({ SLATE_TREE_SITTER_NODE_DEPS: join(root, "missing") });
    assert.equal(report.status, "error");
    assert.equal(report.domain, "developer");
    assert.equal(report.code, "SLATE_TREE_SITTER_RUNTIME_UNAVAILABLE");
    assert.deepEqual(report.roots, [join(root, "missing")]);
  });
});

test("a staged stub build reports itself and degrades the analysis", () => {
  withFixtures((root) => {
    writePackage(root, "tree-sitter", STUB_PARSER);
    writePackage(root, "tree-sitter-bash", "module.exports = { language: true };");
    const { report, stderr } = runChild({ SLATE_PACKAGED: "1", SLATE_TREE_SITTER_NODE_DEPS: root });
    assert.equal(report.status, "loaded");
    assert.equal(report.stubCode, TREE_SITTER_STUBBED_ERROR_CODE);
    assert.equal(report.analysis?.structured?.parsingFailed, true);
    assert.deepEqual(report.analysis?.legacy?.simpleCommands, []);
    assert.equal(stderr.includes("analysis degrades to parsingFailed"), true);
  });
});

test("a staged native that cannot be loaded is terminal and names its domain", () => {
  withFixtures((root) => {
    writePackage(root, "tree-sitter", 'throw new Error("cannot open shared object file");');
    writePackage(root, "tree-sitter-bash", "module.exports = {};");
    const { report } = runChild({ SLATE_PACKAGED: "1", SLATE_TREE_SITTER_NODE_DEPS: root });
    assert.equal(report.status, "error");
    assert.equal(report.code, "SLATE_TREE_SITTER_RUNTIME_UNAVAILABLE");
    assert.equal(report.dependency, "tree-sitter");
    assert.equal(report.domain, "node dist/node-deps");
    assert.deepEqual(report.roots, [root]);
    assert.equal(report.message?.startsWith("shell-parser: cannot load tree-sitter from"), true);
    assert.match(report.message ?? "", /node dist\/node-deps runtime domain/);
    assert.match(report.message ?? "", /refusing cross-ABI fallback/);
    assert.match(report.message ?? "", /Loader error: cannot open shared object file/);
    assert.equal(report.causeMessage, "cannot open shared object file");
  });
});

test("a packaged runtime with no staged root says where it looked", () => {
  withFixtures((root) => {
    const missing = join(root, "not-staged");
    const { report } = runChild({ SLATE_PACKAGED: "1", SLATE_TREE_SITTER_NODE_DEPS: missing });
    assert.equal(report.status, "error");
    assert.equal(report.domain, "node dist/node-deps");
    assert.equal(report.dependency, "tree-sitter");
    assert.deepEqual(report.roots, [missing]);
    assert.match(report.message ?? "", /searched /);
    // No package was even found, so there is no loader failure behind the message.
    assert.equal(report.causeMessage, undefined);
    assert.equal((report.message ?? "").includes("Loader error"), false);
  });
});