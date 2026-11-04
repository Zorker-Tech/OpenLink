import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  getLocalInferenceCliStatus,
  resolveClaudeCodeCliPath,
  resolveCodexCliPath,
} from "../../source/shared/node/inference-router-local.ts";

const roots: string[] = [];
const scratch = (): string => {
  const root = mkdtempSync(join(tmpdir(), "slate-cli-"));
  roots.push(root);
  return root;
};
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** Runs `body` with these environment variables set, and puts them back afterwards. */
function withEnv<T>(values: Record<string, string | undefined>, body: () => T): T {
  const before = new Map(Object.keys(values).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return body();
  } finally {
    for (const [name, value] of before) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/** A login file with these tokens, in a directory of its own. */
function loginFile(tokens: Record<string, unknown> = { access_token: "a", refresh_token: "r", id_token: "i", account_id: "c" }, authMode: unknown = "chatgpt"): { home: string; path: string } {
  const home = scratch();
  const path = join(home, "auth.json");
  writeFileSync(path, JSON.stringify({ auth_mode: authMode, tokens }));
  chmodSync(path, 0o600);
  return { home, path };
}

describe("whether a local inference client can be used", () => {
  it("takes codex as installed by its login file, and signed in only when that file is usable", () => {
    const { home } = loginFile();
    const usable = withEnv({ CODEX_HOME: home }, () => getLocalInferenceCliStatus().codex);
    assert.equal(usable.installed, true);
    assert.equal(usable.authenticated, true);
  });

  it("does not take a login file this build cannot use as a sign-in", () => {
    const cases: Array<[string, Record<string, unknown>, unknown]> = [
      ["one token is missing", { access_token: "a", refresh_token: "r", id_token: "i" }, "chatgpt"],
      ["a token is empty", { access_token: "", refresh_token: "r", id_token: "i", account_id: "c" }, "chatgpt"],
      ["the auth mode is another one", { access_token: "a", refresh_token: "r", id_token: "i", account_id: "c" }, "api-key"],
    ];
    for (const [label, tokens, authMode] of cases) {
      const { home } = loginFile(tokens, authMode);
      const status = withEnv({ CODEX_HOME: home }, () => getLocalInferenceCliStatus().codex);
      assert.equal(status.installed, true, label);
      assert.equal(status.authenticated, false, label);
    }
  });

  it("does not use a login file that others can read, or one that is a link", () => {
    const open = loginFile();
    chmodSync(open.path, 0o644);
    assert.equal(withEnv({ CODEX_HOME: open.home }, () => getLocalInferenceCliStatus().codex.authenticated), false, "readable by others");

    const linked = loginFile();
    const link = join(linked.home, "linked.json");
    symlinkSync(linked.path, link);
    assert.equal(withEnv({ CODEX_HOME: linked.home }, () => getLocalInferenceCliStatus().codex.authenticated), true, "the file itself is fine");
    const viaLink = scratch();
    symlinkSync(linked.path, join(viaLink, "auth.json"));
    assert.equal(withEnv({ CODEX_HOME: viaLink }, () => getLocalInferenceCliStatus().codex.authenticated), false, "a link is not the file");
  });

  it("is not installed when there is no login file, and never throws for one it cannot read", () => {
    const empty = scratch();
    const status = withEnv({ CODEX_HOME: empty }, () => getLocalInferenceCliStatus().codex);
    assert.equal(status.installed, false);
    assert.equal(status.authenticated, false);

    const broken = scratch();
    writeFileSync(join(broken, "auth.json"), "not json");
    chmodSync(join(broken, "auth.json"), 0o600);
    assert.equal(withEnv({ CODEX_HOME: broken }, () => getLocalInferenceCliStatus().codex.authenticated), false);
  });

  it("finds a claude-code binary the PATH holds, and nothing when the PATH holds none", () => {
    const withBinary = scratch();
    writeFileSync(join(withBinary, "claude"), "#!/bin/sh\n");
    chmodSync(join(withBinary, "claude"), 0o755);
    const found = withEnv({ PATH: withBinary, CLAUDE_CODE_PATH: undefined }, () => resolveClaudeCodeCliPath());
    assert.equal(found, join(withBinary, "claude"));

    const empty = scratch();
    const none = withEnv({ PATH: empty, CLAUDE_CODE_PATH: undefined }, () => resolveClaudeCodeCliPath());
    assert.equal(none, null);
  });

  it("takes the environment's own path for a client, and only when it is really there", () => {
    const root = scratch();
    const binary = join(root, "codex");
    writeFileSync(binary, "#!/bin/sh\n");
    chmodSync(binary, 0o755);
    assert.equal(withEnv({ CODEX_PATH: binary }, () => resolveCodexCliPath()), binary);
    const isolatedHome = scratch();
    assert.equal(
      withEnv({ CODEX_PATH: join(root, "missing"), HOME: isolatedHome, PATH: isolatedHome }, () => resolveCodexCliPath()),
      null,
    );
  });

  it("takes a claude-code as signed in by its credentials file or by a key in the environment, and not otherwise", () => {
    const empty = scratch();
    assert.equal(withEnv({ HOME: empty, ANTHROPIC_API_KEY: undefined }, () => getLocalInferenceCliStatus()["claude-code"].authenticated), false, "no credentials file and no key");

    const withCredentials = scratch();
    mkdirSync(join(withCredentials, ".claude"), { recursive: true });
    writeFileSync(join(withCredentials, ".claude", ".credentials.json"), "{}");
    assert.equal(withEnv({ HOME: withCredentials, ANTHROPIC_API_KEY: undefined }, () => getLocalInferenceCliStatus()["claude-code"].authenticated), true, "a credentials file");

    assert.equal(withEnv({ HOME: empty, ANTHROPIC_API_KEY: "key" }, () => getLocalInferenceCliStatus()["claude-code"].authenticated), true, "a key in the environment");
  });
});
