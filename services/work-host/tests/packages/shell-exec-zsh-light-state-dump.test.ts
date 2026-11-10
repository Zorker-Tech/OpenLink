import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { ZSH_STATE_LIGHT_MARKER, default as dumpZshStateLight } from "../../source/packages/shell-exec/dump_zsh_state_light.ts";
import { getZshPath } from "../../source/packages/shell-exec/platform-shell.ts";

function readEncodedSection(output: string, section: "ENV_VARS_B64" | "ZSH_OPTS_B64"): string {
  const lines = output.split(/\r?\n/);
  const opening = lines.findIndex(line => line.includes(`slate_state_${section}=`));
  assert.notEqual(opening, -1, `expected encoded ${section} output`);
  const payload = lines[opening + 1] ?? "";
  assert.equal(lines[opening + 2], `SLATE_STATE_EOF_${section}`);
  return Buffer.from(payload, "base64").toString("utf8");
}

describe("the light-shell snapshot", () => {
  it("records only safe exported variables and replayable options, plus aliases but no functions", () => {
    const directory = mkdtempSync(join(tmpdir(), "slate-zsh-light-snapshot-"));
    const env = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: directory,
      ZDOTDIR: directory,
      PS1: "",
      TERM: "dumb",
      SLATE_KEEP_LIGHT: "kept-value",
      HTTP_PROXY: "hidden-proxy-value",
      SLATE_SANDBOX_PRIVATE: "hidden-sandbox-value",
      SUDO_ASKPASS: "hidden-sudo-value",
      SLATE_ASKPASS: "hidden-askpass-value",
      SLATE_CONVERSATION_ID: "hidden-conversation-value",
      SLATE_AGENT_STORE: "hidden-store-value",
    };
    const source = [
      dumpZshStateLight,
      "setopt pipefail nounset errreturn",
      "alias light_alias='command printf alias-kept'",
      "alias -g LIGHT_GLOBAL='global-kept'",
      "alias -s light='suffix-kept'",
      "function user_only_function() { command printf function-hidden }",
      "dump_zsh_state_light",
    ].join("\n");

    try {
      const result = spawnSync(getZshPath(), ["-c", source], {
        cwd: directory,
        env,
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.stdout.startsWith(`${ZSH_STATE_LIGHT_MARKER}\n${realpathSync(directory)}\n`));

      const environment = readEncodedSection(result.stdout, "ENV_VARS_B64");
      assert.match(environment, /SLATE_KEEP_LIGHT/);
      assert.match(environment, /kept-value/);
      for (const hidden of ["HTTP_PROXY", "SLATE_SANDBOX_PRIVATE", "SUDO_ASKPASS", "SLATE_ASKPASS", "SLATE_CONVERSATION_ID", "SLATE_AGENT_STORE", "hidden-"]) {
        assert.doesNotMatch(environment, new RegExp(hidden));
      }

      const options = readEncodedSection(result.stdout, "ZSH_OPTS_B64");
      assert.doesNotMatch(options, /setopt (?:errreturn|nounset|pipefail)\b/);
      assert.match(result.stdout, /alias light_alias=/);
      assert.match(result.stdout, /alias -g LIGHT_GLOBAL=/);
      assert.match(result.stdout, /alias -s light=/);
      assert.doesNotMatch(result.stdout, /user_only_function/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
