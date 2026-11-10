import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChildProcess } from "node:child_process";

import { getSandboxCacheEnv } from "../../source/adapters/interop/shell/sandbox-cache-environment-adapter.ts";
import { spawnInSandbox } from "../../source/packages/shell-exec/sandbox/sandbox.ts";

async function collectStdout(child: ChildProcess): Promise<string> {
  return await new Promise((resolve, reject) => {
    let output = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`child exited with code ${String(code)}: ${output}`));
    });
  });
}

test("an unrestricted command uses the direct runner and keeps caller environment values", async () => {
  const options = { env: { SLATE_SPAWN_CONTRACT_VALUE: "kept" } };
  const output = await collectStdout(spawnInSandbox(
    process.execPath,
    ["-e", "process.stdout.write(process.env.SLATE_SPAWN_CONTRACT_VALUE ?? 'missing')"],
    options,
    { type: "insecure_none" },
  ));

  assert.equal(output, "kept");
});

test("shared cache defaults are added while explicit caller values take precedence", async () => {
  const cachePath = "/tmp/slate-explicit-cache";
  const options = {
    env: {
      SLATE_SPAWN_CONTRACT_VALUE: "kept",
      NPM_CONFIG_CACHE: cachePath,
    },
  };
  const script = "process.stdout.write(JSON.stringify({ marker: process.env.SLATE_SPAWN_CONTRACT_VALUE, npm: process.env.NPM_CONFIG_CACHE, cargo: process.env.CARGO_TARGET_DIR ?? null }))";
  const output = await collectStdout(spawnInSandbox(
    process.execPath,
    ["-e", script],
    options,
    { type: "insecure_none", enableSharedBuildCache: true },
  ));

  assert.deepEqual(JSON.parse(output), {
    marker: "kept",
    npm: cachePath,
    cargo: getSandboxCacheEnv().CARGO_TARGET_DIR,
  });
});
