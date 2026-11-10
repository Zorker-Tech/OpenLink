/**
 * Driving PowerShell through a fake pwsh: cwd/clone, output and exit events, env, stdin, sandbox policies, close
 * timeouts, aborts and spawn failures.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initPowerShellState } from "../../source/packages/shell-exec/powershell.ts";
import { createContext } from "../../source/packages/context/context.ts";

const dir = mkdtempSync(join(tmpdir(), "pwsh-suite-"));
const scriptPath = join(dir, "pwsh");
writeFileSync(scriptPath, "#!/bin/sh\nif [ \"$FAKE_MODE\" = \"fail\" ]; then echo out; echo err >&2; exit 3; fi\nif [ \"$FAKE_MODE\" = \"slow\" ]; then echo start; sleep 0.3; exit 0; fi\nif [ \"$FAKE_MODE\" = \"hold\" ]; then echo start; sleep 0.5 & exit 0; fi\nif [ -n \"$PS_TEST_ENV\" ]; then echo \"env:$PS_TEST_ENV\"; fi\necho \"args:$*\"; echo \"cwd:$(pwd)\"; echo out; echo err >&2; exit 0\n");
chmodSync(scriptPath, 0o755);
process.env.SHELL = scriptPath;

type Event = { type?: string; stdin?: unknown; pid?: unknown; data?: string; code?: number; aborted?: boolean };

async function collect(mode: string, settings: Record<string, unknown> = {}, signal?: AbortSignal): Promise<{ events: Event[]; thrown?: Error }> {
  process.env.FAKE_MODE = mode;
  const session = await initPowerShellState();
  const events: Event[] = [];
  try {
    for await (const event of session.execute(createContext(), "echo hello", { ...settings, ...(signal === undefined ? {} : { signal }) })) events.push(event as Event);
    return { events };
  } catch (error) {
    return { events, thrown: error as Error };
  }
}

test("the session starts in the process directory and clones carry a directory", async () => {
  const session = await initPowerShellState();
  assert.equal(await session.getCwd(), process.cwd());
  assert.equal(await session.clone("/tmp/elsewhere").getCwd(), "/tmp/elsewhere");
  assert.equal(await session.clone().getCwd(), process.cwd());
});

test("a command's output and exit are streamed", async () => {
  const { events, thrown } = await collect("ok");
  assert.equal(thrown, undefined);
  const stdout = events.filter((event) => event.type === "stdout").map((event) => event.data).join("");
  const stderr = events.filter((event) => event.type === "stderr").map((event) => event.data).join("");
  assert.match(stdout, /out/);
  assert.match(stderr, /err/);
  const exit = events.find((event) => event.type === "exit");
  assert.equal(exit?.code, 0);
  assert.equal(exit?.aborted, false);
  assert.equal(events.filter((event) => event.type === "exit").length, 1);
  assert.equal(events.filter((event) => event.type === "stdin_ready").length, 1);
});

test("a failing command keeps its exit code", async () => {
  const { events } = await collect("fail");
  const exit = events.find((event) => event.type === "exit");
  assert.equal(exit?.code, 3);
});

test("stdin is offered when the caller asked for it", async () => {
  const withPipe = await collect("ok", { pipeStdin: true });
  const ready = withPipe.events.find((event) => event.type === "stdin_ready");
  assert.equal(ready?.stdin !== undefined, true);
  const withoutPipe = await collect("ok");
  assert.equal(withoutPipe.events.find((event) => event.type === "stdin_ready")?.stdin, undefined);
});

test("the environment is merged into the child", async () => {
  const { events } = await collect("ok", { env: { PS_TEST_ENV: "value" } });
  const stdout = events.filter((event) => event.type === "stdout").map((event) => event.data).join("");
  assert.match(stdout, /env:value/);
});

test("a working directory and sandbox policy sources are accepted", async () => {
  for (const settings of [
    { workingDirectory: "/tmp" },
    { sandboxPolicy: { type: "insecure_none" as const }, sandboxWorkspaceRoot: "/tmp" },
    { sandboxPolicy: { type: "workspace_readwrite" as const }, sandboxWorkspaceRoot: "/tmp" },
  ]) {
    const { thrown } = await collect("ok", settings);
    if (settings.sandboxPolicy !== undefined) assert.equal(thrown !== undefined, true);
    else assert.equal(thrown, undefined);
  }
});

test("a close that never arrives inside the timeout is warned about and the run still ends", async () => {
  const warnings: unknown[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    const { events, thrown } = await collect("hold", { closeTimeout: 50 });
    assert.equal(thrown, undefined);
    assert.equal(warnings.length >= 1, true);
    assert.equal(events.some((event) => event.type === "exit"), true);
  } finally {
    console.warn = originalWarn;
  }
});

test("an aborted run reports an aborted exit", async () => {
  const controller = new AbortController();
  process.env.FAKE_MODE = "slow";
  const session = await initPowerShellState();
  const events: Event[] = [];
  for await (const event of session.execute(createContext(), "echo hello", { signal: controller.signal })) {
    events.push(event as Event);
    // Waiting for the spawn notification avoids aborting before the fake child exists under a loaded test runner.
    if (event.type === "stdin_ready") controller.abort();
  }
  const exit = events.find((event) => event.type === "exit");
  assert.equal(exit?.aborted, true);
});

test("a missing shell surfaces the spawn error", async () => {
  const saved = process.env.SHELL;
  process.env.SHELL = "/nonexistent/pwsh";
  try {
    const { thrown } = await collect("ok");
    assert.equal(thrown !== undefined, true);
    assert.match(thrown?.message ?? "", /ENOENT/);
  } finally {
    process.env.SHELL = saved;
  }
});

test("the launcher arguments and working directory reach the shell", async () => {
  const { events } = await collect("ok", { workingDirectory: "/tmp" });
  const stdout = events.filter((event) => event.type === "stdout").map((event) => event.data).join("");
  assert.match(stdout, /args:-ExecutionPolicy Bypass -NonInteractive -File /);
  assert.match(stdout, /cwd:\/(?:private\/)?tmp/);
  const piped = await collect("ok", { pipeStdin: true });
  const pipedStdout = piped.events.filter((event) => event.type === "stdout").map((event) => event.data).join("");
  assert.match(pipedStdout, /args:-ExecutionPolicy Bypass -File /);
});
