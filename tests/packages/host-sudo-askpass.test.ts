import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SUDO_ALIAS,
  getSudoAliasInjection,
  shouldEnableSudoAskpass,
  transformSudoCommand,
} from "../../source/packages/shell-exec/sudo.ts";

describe("a sudo that would otherwise stop and ask", () => {
  it("is turned into one that asks the configured helper, at the start of a command", () => {
    assert.equal(transformSudoCommand("sudo ls"), "sudo -A ls");
    // Pinned as it behaves: a command that starts after spaces at the very beginning is not rewritten, because the
    // check looks for a separator rather than for the text before it being blank.
    assert.equal(transformSudoCommand("  sudo ls"), "  sudo ls");
    assert.equal(transformSudoCommand("a &&  sudo ls"), "a &&  sudo -A ls", "a separator and its padding are a command start");
    assert.equal(transformSudoCommand("echo hi && sudo ls"), "echo hi && sudo -A ls");
    assert.equal(transformSudoCommand("echo hi || sudo ls"), "echo hi || sudo -A ls");
    assert.equal(transformSudoCommand("echo hi | sudo ls"), "echo hi | sudo -A ls");
    assert.equal(transformSudoCommand("echo hi; sudo ls"), "echo hi; sudo -A ls");
    assert.equal(transformSudoCommand("sudo"), "sudo -A");
  });

  it("is left alone when it already carries the flag, however the flags are written", () => {
    assert.equal(transformSudoCommand("sudo -A ls"), "sudo -A ls");
    assert.equal(transformSudoCommand("sudo -nA ls"), "sudo -nA ls");
    assert.equal(transformSudoCommand("sudo -An ls"), "sudo -An ls");
  });

  it("is rewritten when its flags are not the askpass one, and left when they are", () => {
    assert.equal(transformSudoCommand("sudo -n ls"), "sudo -A -n ls", "a flag that is not the askpass one is still a flag");
    assert.equal(transformSudoCommand("sudo -k ls"), "sudo -A -k ls");
    assert.equal(transformSudoCommand("sudo -a ls"), "sudo -A -a ls", "only the capital A is the askpass flag");
  });

  it("is a command start after a separator, and not after a word", () => {
    assert.equal(transformSudoCommand("a;sudo ls"), "a;sudo -A ls");
    assert.equal(transformSudoCommand("a|sudo ls"), "a|sudo -A ls");
    assert.equal(transformSudoCommand("a sudo ls"), "a sudo ls", "a word before it is not a separator");
  });

  it("is left alone when it is not the command being run", () => {
    assert.equal(transformSudoCommand("echo 'sudo ls'"), "echo 'sudo ls'");
    assert.equal(transformSudoCommand("echo sudo"), "echo sudo");
    assert.equal(transformSudoCommand("sudont ls"), "sudont ls");
  });

  it("is told about the helper by an alias, only where one can answer", () => {
    assert.equal(SUDO_ALIAS, "alias sudo='sudo -A'");
    assert.equal(shouldEnableSudoAskpass({ SUDO_ASKPASS: "/usr/lib/askpass" } as never), true);
    assert.equal(shouldEnableSudoAskpass({} as never), false);
    assert.equal(shouldEnableSudoAskpass({ SUDO_ASKPASS: "" } as never), false, "a helper that names nothing is no helper");
    assert.equal(getSudoAliasInjection({ SUDO_ASKPASS: "/usr/lib/askpass" } as never), "alias sudo='sudo -A'; ");
    assert.equal(getSudoAliasInjection({} as never), "");
  });
});
