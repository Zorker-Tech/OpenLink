import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { KnownShellExecutor, SHELL_ENV_OVERRIDES } from "../../source/packages/shell-exec/types.ts";

describe("the shells the platform can drive", () => {
  it("are named the way the platform selects them", () => {
    assert.deepEqual(Object.entries(KnownShellExecutor), [
      ["Zsh", "zsh"],
      ["ZshLight", "zsh-light"],
      ["Bash", "bash"],
      ["PowerShell", "powershell"],
      ["Naive", "naive"],
    ]);
    assert.equal(KnownShellExecutor.Zsh, "zsh");
    assert.equal(KnownShellExecutor.PowerShell, "powershell");
  });

  it("run with the environment the platform sets", () => {
    assert.deepEqual(SHELL_ENV_OVERRIDES, { TERM: "dumb", NO_COLOR: "1", FORCE_COLOR: "0", _ZO_DOCTOR: "0" });
    assert.deepEqual(Object.keys(SHELL_ENV_OVERRIDES), ["TERM", "NO_COLOR", "FORCE_COLOR", "_ZO_DOCTOR"]);
  });
});
