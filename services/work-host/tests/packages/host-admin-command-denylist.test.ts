/**
 * The administrator's command denylist: how rules are matched against canonicalized commands (quoting, escapes,
 * globs, colon rules), and what the block messages say.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  formatAdminCommandDenylistBlockReason,
  getModelShellAdminCommandDenylistBlockReason,
} from "../../source/packages/local-exec/services/admin-command-denylist.ts";

const parsing = (commands: string[], failed = false) => ({ parsingFailed: failed, executableCommands: commands.map((fullText) => ({ fullText })) });
const ask = (command: string, rules: string[], analyzed: string[] = [command], failed = false) =>
  getModelShellAdminCommandDenylistBlockReason({ command, parsingResult: parsing(analyzed, failed), blockedCommands: rules });

test("with no rules nothing is blocked", () => {
  assert.equal(ask("rm -rf /", []), undefined);
  assert.equal(ask("", []), undefined);
});

test("a plain rule blocks the command and its arguments, case-sensitively", () => {
  assert.notEqual(ask("rm -rf /", ["rm"]), undefined);
  assert.notEqual(ask("rm", ["rm"]), undefined);
  assert.equal(ask("rmdir x", ["rm"]), undefined);
  assert.equal(ask("RM -rf /", ["rm"]), undefined);
  assert.notEqual(ask("  rm   -rf /  ", ["rm"]), undefined);
  assert.equal(ask("echo hi", ["rm"]), undefined);
});

test("exact rules, prefix rules and glob rules each match as written", () => {
  assert.notEqual(ask("git push --force", ["git push --force"]), undefined);
  assert.notEqual(ask("git push --force origin", ["git push --force"]), undefined);
  assert.notEqual(ask("git push origin", ["git push *"]), undefined);
  assert.notEqual(ask("docker run alpine", ["docker *"]), undefined);
  assert.notEqual(ask("*", ["*"]), undefined);
});

test("quoting and escapes cannot be used to slip past a rule", () => {
  assert.notEqual(ask("echo 'a b'", ["echo a b"]), undefined);
  assert.notEqual(ask("echo \"a b\"", ["echo a b"]), undefined);
  assert.notEqual(ask("echo a\\ b", ["echo a b"]), undefined);
  assert.notEqual(ask("echo $'a\\tb'", ["echo a\tb"]), undefined);
  assert.notEqual(ask("echo $'\\u0041'", ["echo A"]), undefined);
  assert.notEqual(ask("echo $'\\x41'", ["echo A"]), undefined);
  assert.notEqual(ask("echo $'\\101'", ["echo A"]), undefined);
  assert.notEqual(ask("echo \\n", ["echo"]), undefined);
  assert.notEqual(ask("echo \\n", ["echo n"]), undefined);
  assert.equal(ask("echo \\x41", ["echo A"]), undefined);
  assert.notEqual(ask("echo \\x41", ["echo x41"]), undefined);
  assert.equal(ask("echo \\u0041", ["echo A"]), undefined);
  assert.notEqual(ask("echo \\u0041", ["echo u0041"]), undefined);
  assert.equal(ask("echo \\U00000041", ["echo A"]), undefined);
  assert.notEqual(ask("echo \\U00000041", ["echo U00000041"]), undefined);
  assert.notEqual(ask("echo \\U00110000", ["echo"]), undefined);
  assert.notEqual(ask("echo 'unterminated", ["echo unterminated"]), undefined);
});

test("colon rules match the program and the arguments separately", () => {
  assert.equal(ask("git push --force", ["git push:*"]), undefined);
  assert.notEqual(ask("git push --force", ["git:p*"]), undefined);
  assert.notEqual(ask("rm -rf /", ["rm:-rf *"]), undefined);
  assert.notEqual(ask("rm", ["rm:*"]), undefined);
  assert.notEqual(ask("curl https://x", ["curl:*"]), undefined);
  assert.notEqual(ask("curl", ["curl:*"]), undefined);
});

test("a rule that cannot be parsed blocks rather than lets through", () => {
  assert.equal(ask("rm -rf /", ["["]), undefined);
  assert.equal(ask("rm -rf /", [""]), undefined);
  assert.equal(ask("rm -rf /", ["   "]), undefined);
  assert.equal(ask("rm -rf /", ["a:b:c"]), undefined);
});

test("every analyzed command is matched, not just the raw line", () => {
  assert.notEqual(ask("bash -c 'rm -rf /'", ["rm"], ["bash", "rm"]), undefined);
  assert.notEqual(ask("sh -c 'curl x'", ["curl"], ["sh", "curl"]), undefined);
  assert.notEqual(ask("echo hi", ["echo"], ["echo", "hi"]), undefined);
});

test("a command that could not be analyzed fails closed", () => {
  const blocked = ask("rm -rf /", ["rm"], [], true);
  assert.match(blocked ?? "", /could not be conclusively analyzed/);
  assert.match(ask("rm -rf /", ["rm"], []) ?? "", /could not be conclusively analyzed/);
  assert.match(ask("anything", ["x"], [], true) ?? "", /could not be conclusively analyzed/);
  assert.equal(ask("rm -rf /", [], [], true), undefined);
});

test("the block reason names the rule and says how to proceed", () => {
  assert.equal(
    formatAdminCommandDenylistBlockReason("rm"),
    "Denied: this command was blocked by administrator policy (denylist rule: rm) and was not executed. It cannot be approved from this conversation; only a user can run it manually outside the agent. You may continue working on the task.",
  );
  assert.match(formatAdminCommandDenylistBlockReason(""), /denylist rule: \)/);
});

test("double-quoted escapes are canonicalized the way a shell would", () => {
  assert.notEqual(ask("echo \"a\\$b\"", ["echo a$b"]), undefined);
  assert.notEqual(ask("echo \"a\\qb\"", ["echo a\\qb"]), undefined);
  assert.equal(ask("echo \"a\\qb\"", ["echo aqb"]), undefined);
});

test("a colon rule only blocks when both sides match", () => {
  assert.equal(ask("git push --force", ["git:nomatch"]), undefined);
  assert.equal(ask("git push --force", ["git:--force"]), undefined);
});

test("the fail-closed message is exact", () => {
  assert.equal(
    ask("rm -rf /", ["rm"], [], true),
    "Denied: this command could not be conclusively analyzed against your team's administrator command denylist, so it was blocked (fail-closed) and was not executed. It cannot be approved from this conversation; only a user can run it manually outside the agent. You may continue working on the task.",
  );
});
