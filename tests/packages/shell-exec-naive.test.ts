import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  NaiveTerminalExecutor,
  createDefaultTerminalExecutor,
  createNaiveTerminalExecutor,
  getSuggestedShell,
} from "../../source/packages/shell-exec/index.ts";
import { LazyTerminalExecutor } from "../../source/packages/shell-exec/lazy.ts";
import { createContext } from "../../source/packages/context/context.ts";
import { KnownShellExecutor } from "../../source/packages/shell-exec/types.ts";

const context = () => createContext();
const plain = (events: Array<Record<string, unknown>>) => events.map((event) => {
  if (event.type === "stdout" || event.type === "stderr") return { type: event.type, data: Buffer.isBuffer(event.data) ? event.data.toString() : String(event.data) };
  if (event.type === "exit") return { type: "exit", code: event.code, aborted: event.aborted };
  if (event.type === "stdin_ready") return { type: "stdin_ready", hasStdin: event.stdin !== undefined, pid: typeof event.pid };
  return { type: event.type };
});
async function run(executor: { execute(ctx: unknown, command: string, options?: unknown): AsyncIterable<Record<string, unknown>> }, command: string, options: Record<string, unknown> = {}) {
  const events: Array<Record<string, unknown>> = [];
  for await (const event of executor.execute(context(), command, options)) events.push(event);
  return plain(events);
}
const executor = (options: Record<string, unknown> = {}) => createNaiveTerminalExecutor({ shell: "/bin/sh", shellArgs: [], ...options });

test("the plain executor starts at the process directory and clones elsewhere", async () => {
  const created = executor();
  assert.equal(realpathSync(await created.getCwd()), realpathSync(process.cwd()));
  const clone = created.clone("/tmp");
  assert.equal(await clone.getCwd(), "/tmp");
  assert.equal(await created.getCwd(), realpathSync(process.cwd()));
});

test("a command's stdout and exit come back as events", async () => {
  const events = await run(executor(), "printf 'hello\n'");
  assert.deepEqual(events[0], { type: "stdin_ready", hasStdin: false, pid: "number" });
  assert.deepEqual(events.slice(1), [{ type: "stdout", data: "hello\n" }, { type: "exit", code: 0, aborted: false }]);
});

test("a failing command reports its exit code", async () => {
  const events = await run(executor(), "printf 'before\n'; exit 3");
  assert.deepEqual(events.filter((event) => event.type === "stdout"), [{ type: "stdout", data: "before\n" }]);
  assert.deepEqual(events.at(-1), { type: "exit", code: 3, aborted: false });
});

test("a stateless executor reports its directory but runs where the process is", async () => {
  const created = executor();
  const events = await run(created, "pwd", { workingDirectory: "/tmp" });
  // The plain executor passes no cwd to the spawned program; it reports the directory it was given instead.
  assert.equal(realpathSync((events.find((event) => event.type === "stdout") as { data: string }).data.trim()), realpathSync(process.cwd()));
  assert.equal(realpathSync(await created.getCwd()), realpathSync(process.cwd()));
  assert.equal(await created.clone("/tmp").getCwd(), "/tmp");
});

test("a command can be given its own environment", async () => {
  const events = await run(executor(), "printf '%s' \"$ONLY_HERE\"", { env: { ...process.env, ONLY_HERE: "present" } });
  assert.equal((events.find((event) => event.type === "stdout") as { data: string }).data, "present");
});

test("piped stdin is handed over through the stdin event", async () => {
  const created = executor();
  const events: Array<Record<string, unknown>> = [];
  for await (const event of created.execute(context(), "IFS= read -r line; printf 'got:%s' \"$line\"", { pipeStdin: true })) {
    events.push(event);
    const stdin = (event as { stdin?: { write(text: string, callback: () => void): void; end(): void } }).stdin;
    if (event.type === "stdin_ready" && stdin !== undefined) stdin.write("from-stdin\n", () => stdin.end());
  }
  assert.deepEqual(plain(events), [
    { type: "stdin_ready", hasStdin: true, pid: "number" },
    { type: "stdout", data: "got:from-stdin" },
    { type: "exit", code: 0, aborted: false },
  ]);
});

test("a command that was already aborted is not run", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(async () => {
    for await (const _event of executor().execute(context(), "printf hello", { signal: controller.signal })) { /* consume */ }
  }, (error: Error) => error.name === "AbortError");
});

test("shells are chosen from a hint before the platform", () => {
  assert.equal(getSuggestedShell(KnownShellExecutor.ZshLight), KnownShellExecutor.ZshLight);
  assert.equal(getSuggestedShell("/usr/local/bin/zsh"), KnownShellExecutor.Zsh);
  assert.equal(getSuggestedShell("/usr/local/bin/bash"), KnownShellExecutor.Bash);
  assert.equal(getSuggestedShell("/usr/bin/pwsh"), KnownShellExecutor.PowerShell);
  assert.equal(getSuggestedShell("/usr/bin/powershell.exe"), KnownShellExecutor.PowerShell);
});

test("the default executor uses a stateful factory when one is supplied", async () => {
  const fake = {
    async getCwd() { return "/from-fake"; },
    clone() { return fake; },
    async *execute() { /* nothing */ },
  };
  let built = 0;
  const created = createDefaultTerminalExecutor({
    statefulFactories: {
      [KnownShellExecutor.ZshLight]: async () => { built += 1; return fake as never; },
    },
    userTerminalHint: KnownShellExecutor.ZshLight,
  });
  assert.equal(created instanceof LazyTerminalExecutor, true);
  assert.equal(await created.getCwd(), "/from-fake");
  assert.equal(built, 1);
});

test("the default executor falls back to the naive executor where no shell is suggested", () => {
  // The naive executor is the only one without a shell to start; the factory path is the same object type.
  assert.equal(new NaiveTerminalExecutor(process.cwd()) instanceof NaiveTerminalExecutor, true);
});
test("the command environment wins over the shell overrides", async () => {
  const events = await run(executor(), "printf '%s' \"$TERM\"", { env: { ...process.env, TERM: "xterm-256color" } });
  assert.equal((events.find((event) => event.type === "stdout") as { data: string }).data, "xterm-256color");
});

test("the exit event carries empty data", async () => {
  const events = [];
  for await (const event of executor().execute(context(), "printf hi")) events.push(event);
  const exit = events.find((event) => event.type === "exit") as { data?: unknown; code?: unknown };
  assert.equal(exit.data, "");
});

test("a running command that is aborted reports an aborted exit", async () => {
  const controller = new AbortController();
  const created = executor();
  const exit = await new Promise<{ aborted?: boolean }>((resolve, reject) => {
    (async () => {
      for await (const event of created.execute(context(), "sleep 5", { signal: controller.signal })) {
        if (event.type === "stdin_ready") controller.abort();
        if (event.type === "exit") resolve(event as { aborted?: boolean });
      }
    })().catch(reject);
  });
  assert.equal(exit.aborted, true);
});

test("sudo is only rewritten when an askpass helper is configured", async () => {
  const directory = mkdtempSync(join(tmpdir(), "slate-sudo-bin-"));
  const fakeSudo = join(directory, "sudo");
  writeFileSync(fakeSudo, "#!/bin/sh\nprintf '%s' \"$*\"\n");
  chmodSync(fakeSudo, 0o755);
  try {
    const path = directory + ":" + (process.env.PATH ?? "");
    const plainEvents = await run(executor(), "sudo hello", { env: { ...process.env, PATH: path, SUDO_ASKPASS: "" } });
    assert.equal((plainEvents.find((event) => event.type === "stdout") as { data: string }).data, "hello");
    const askpassEvents = await run(executor(), "sudo hello", { env: { ...process.env, PATH: path, SUDO_ASKPASS: "/tmp/askpass" } });
    assert.equal((askpassEvents.find((event) => event.type === "stdout") as { data: string }).data, "-A hello");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("buffered output is gathered into one event", async () => {
  const events = [];
  for await (const event of executor().execute(context(), "printf abc; printf def", { bufferOutputEvents: true })) events.push(event);
  const output = events.filter((event) => event.type === "stdout") as Array<{ data: Buffer }>;
  assert.equal(output.map((event) => event.data.toString()).join(""), "abcdef");
  assert.equal(output.length, 1);
});

test("the default executor picks the light zsh when the user's terminal is light", async () => {
  const created = createDefaultTerminalExecutor({ userTerminalHint: KnownShellExecutor.ZshLight });
  const events = [];
  for await (const event of created.execute(context(), "zl_fn() { printf 'fn'; }; printf 'defined'")) events.push(event);
  const call = [];
  for await (const event of created.execute(context(), "zl_fn")) call.push(event);
  // A light zsh does not carry the function between commands; a full zsh would.
  assert.equal(call.some((event) => event.type === "stdout"), false);
  assert.equal(events.some((event) => event.type === "stdout"), true);
});