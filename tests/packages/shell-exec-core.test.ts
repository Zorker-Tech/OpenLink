import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

import {
  attachShellStateOutput,
  createShellExitEvent,
  killDetachedProcessGroup,
  parseShellStateOutput,
  spawnWithSignal,
  splitPwdAndState,
  writeShellStatePipe,
} from "../../source/packages/shell-exec/core.ts";

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const waitExit = (child: { once(event: string, listener: (...args: any[]) => void): unknown }, timeout = 3000) =>
  new Promise<{ code: number | null; signal: string | null } | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), timeout);
    child.once("exit", (code: number | null, signal: string | null) => { clearTimeout(timer); resolve({ code, signal }); });
  });
const script = (body: string) => ["-c", body];
const waitForGone = async (pid: number, timeout = 3000) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    try { process.kill(pid, 0); } catch { return; }
    await tick(25);
  }
  throw new Error("process " + pid + " is still running");
};


const waitForFile = async (path: string, timeout = 5000) => {
  const startedAt = Date.now();
  while (!existsSync(path)) {
    if (Date.now() - startedAt > timeout) throw new Error("marker file was not written");
    await tick(10);
  }
};



test("the shell exit event carries its code, empty data and abort flag", () => {
  assert.deepEqual(createShellExitEvent(0, false), { type: "exit", code: 0, data: "", aborted: false });
  assert.deepEqual(createShellExitEvent(3, true), { type: "exit", code: 3, data: "", aborted: true });
  assert.deepEqual(createShellExitEvent(null, false), { type: "exit", code: null, data: "", aborted: false });
});

test("a shell state splits at its first newline", () => {
  assert.deepEqual(splitPwdAndState("/tmp\nrest one\nrest two"), { cwd: "/tmp", rest: "\nrest one\nrest two" });
  // With no newline at all, the existing split puts everything in rest and nothing in cwd.
  assert.deepEqual(splitPwdAndState("/tmp"), { cwd: "", rest: "/tmp" });
  assert.deepEqual(splitPwdAndState(""), { cwd: "", rest: "" });
});

test("a state dump is read after its marker and whole when the marker is missing", () => {
  assert.equal(parseShellStateOutput("noise\nMARK\nstate one", "MARK"), "state one");
  assert.equal(parseShellStateOutput("MARK\nstate", "MARK"), "state");
  assert.equal(parseShellStateOutput("no marker here", "MARK"), "no marker here");
});

test("a state pipe is written once, ended, and its errors are swallowed", () => {
  const calls: string[] = [];
  let listener: (() => void) | undefined;
  const stream = {
    on(_event: string, next: () => void) { listener = next; return this; },
    write(text: string) { calls.push("write:" + text); },
    end() { calls.push("end"); },
  };
  writeShellStatePipe(stream as never, "state text");
  writeShellStatePipe(null, "ignored");
  assert.deepEqual(calls, ["write:state text", "end"]);
  assert.equal(typeof listener, "function");
  assert.doesNotThrow(() => listener?.());
});

test("a state output is read chunk by chunk and its errors are swallowed", () => {
  const calls: string[] = [];
  let dataListener: ((data: Buffer | string) => void) | undefined;
  let errorListener: (() => void) | undefined;
  const stream = {
    on(event: string, next: (data: Buffer | string) => void) { if (event === "error") errorListener = next as never; else dataListener = next; return this; },
  };
  attachShellStateOutput(stream as never, (text: string) => calls.push(text));
  dataListener?.(Buffer.from("one"));
  dataListener?.("two");
  assert.deepEqual(calls, ["one", "two"]);
  assert.doesNotThrow(() => errorListener?.());
});

test("an already aborted spawn reports the abort asynchronously", async () => {
  const controller = new AbortController();
  controller.abort();
  const child = spawnWithSignal("/bin/sh", script("printf hi"), {}, { type: "insecure_none" }, controller.signal);
  const errors: Array<[string, string]> = [];
  child.on("error", (error: Error) => errors.push([error.name, error.message]));
  await tick(20);
  assert.deepEqual(errors, [["AbortError", "Operation was aborted"]]);
});

test("a spawned command reports its output and exit", async () => {
  const child = spawnWithSignal("/bin/sh", script("printf hi; exit 3"), {}, { type: "insecure_none" });
  const chunks: string[] = [];
  (child.stdout as EventEmitter).on("data", (data: Buffer) => chunks.push(data.toString()));
  const exit = await waitExit(child as never);
  assert.deepEqual({ output: chunks.join(""), code: exit?.code }, { output: "hi", code: 3 });
});

test("aborting a running command terminates it gracefully", async () => {
  const controller = new AbortController();
  const child = spawnWithSignal("/bin/sh", script("sleep 5"), {}, { type: "insecure_none" }, controller.signal);
  controller.abort();
  const exit = await waitExit(child as never);
  assert.notEqual(exit, null);
  assert.equal(exit?.signal, "SIGTERM");
});

test("a detached group that ignores the polite signal is forced down within a second", async () => {
  const directory = mkdtempSync(join(tmpdir(), "slate-core-abort-group-"));
  const ready = join(directory, "ready");
  try {
  const controller = new AbortController();
  const child = spawnWithSignal("/bin/sh", script("trap '' TERM; : > " + ready + "; while :; do sleep 0.1; done"), { detached: true }, { type: "insecure_none" }, controller.signal);
  await waitForFile(ready);
  const startedAt = Date.now();
  controller.abort();
  const exit = await waitExit(child as never, 2500);
  assert.notEqual(exit, null);
  assert.equal(exit?.signal, "SIGKILL");
  assert.equal(Date.now() - startedAt < 2000, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("aborting a detached group takes its children down too", async () => {
  const directory = mkdtempSync(join(tmpdir(), "slate-core-group-"));
  const pidFile = join(directory, "child.pid");
  try {
    const controller = new AbortController();
    const child = spawnWithSignal("/bin/sh", script("sleep 5 & printf '%s' $! > " + pidFile + "; wait"), { detached: true }, { type: "insecure_none" }, controller.signal);
    await waitForFile(pidFile);
    const grandchild = Number(readFileSync(pidFile, "utf8"));
    controller.abort();
    await waitExit(child as never);
    await waitForGone(grandchild);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("killing a detached group politely then forcibly takes it down", async () => {
  const controller = new AbortController();
  const directory = mkdtempSync(join(tmpdir(), "slate-core-kill-forced-"));
  const ready = join(directory, "ready");
  try {
  const child = spawnWithSignal("/bin/sh", script("trap '' TERM; : > " + ready + "; while :; do sleep 0.1; done"), { detached: true }, { type: "insecure_none" });
  await waitForFile(ready);
  killDetachedProcessGroup(child.pid, "SIGTERM", 100);
  const exit = await waitExit(child as never, 2500);
  assert.notEqual(exit, null);
  assert.equal(exit?.signal, "SIGKILL");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("killing a group that is not there is quiet", () => {
  assert.doesNotThrow(() => killDetachedProcessGroup(undefined, "SIGTERM"));
  assert.doesNotThrow(() => killDetachedProcessGroup(999_999, "SIGTERM", 10));
});
test("killing a detached group takes its children down too", async () => {
  const directory = mkdtempSync(join(tmpdir(), "slate-core-kill-group-"));
  const pidFile = join(directory, "child.pid");
  try {
    const child = spawnWithSignal("/bin/sh", script("trap '' TERM; sleep 5 & printf '%s' $! > " + pidFile + "; wait"), { detached: true }, { type: "insecure_none" });
    await waitForFile(pidFile);
    const grandchild = Number(readFileSync(pidFile, "utf8"));
    killDetachedProcessGroup(child.pid, "SIGTERM", 100);
    await waitExit(child as never, 2500);
    await waitForGone(grandchild);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
