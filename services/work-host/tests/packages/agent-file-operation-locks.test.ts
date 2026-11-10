/**
 * The file-operation lock manager: per-path locks, the exclusive lock, its fairness, aborting waiters and release.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  FileOperationLockManager,
} from "../../source/packages/agent/tools/core/file-operation-locks.ts";

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));
const context = (signal: AbortSignal = new AbortController().signal) => ({ signal } as never);
const dispose = (lock: unknown) => (lock as Record<symbol, () => void>)[Symbol.dispose]!();

test("an uncontended file lock is taken immediately and released once", async () => {
  const manager = new FileOperationLockManager();
  assert.equal(manager.activeFileOperationCount, 0);
  const lock = await manager.waitForLock(context(), "/a");
  assert.equal(manager.activeFileOperationCount, 1);
  assert.equal(lock.acquisitionOrder, undefined);
  dispose(lock);
  dispose(lock);
  assert.equal(manager.activeFileOperationCount, 0);
});

test("acquisition order is assigned only when tracked", async () => {
  const manager = new FileOperationLockManager();
  const first = await manager.waitForLock(context(), "/a", { trackAcquisitionOrder: true });
  const second = await manager.waitForLock(context(), "/b", { trackAcquisitionOrder: true });
  assert.equal(typeof first.acquisitionOrder, "bigint");
  assert.equal(typeof second.acquisitionOrder, "bigint");
  assert.equal(second.acquisitionOrder! > first.acquisitionOrder!, true);
  dispose(first);
  dispose(second);
});

test("a second lock on the same path waits for the first", async () => {
  const manager = new FileOperationLockManager();
  const held = await manager.waitForLock(context(), "/same");
  const waiting = manager.waitForLock(context(), "/same");
  await flush();
  assert.equal(manager.activeFileOperationCount, 1);
  dispose(held);
  const granted = await waiting;
  assert.equal(manager.activeFileOperationCount, 1);
  dispose(granted);
  assert.equal(manager.activeFileOperationCount, 0);
});

test("locks on different paths are held together", async () => {
  const manager = new FileOperationLockManager();
  const a = await manager.waitForLock(context(), "/a");
  const b = await manager.waitForLock(context(), "/b");
  assert.equal(manager.activeFileOperationCount, 2);
  dispose(a);
  dispose(b);
  assert.equal(manager.activeFileOperationCount, 0);
});

test("an exclusive waiter blocks later file locks and is granted first", async () => {
  const manager = new FileOperationLockManager();
  const events: string[] = [];
  const fileHeld = await manager.waitForLock(context(), "/held");
  const exclusiveWait = manager.waitForExclusiveLock(context()).then((lock) => { events.push("exclusive"); return lock; });
  const laterFile = manager.waitForLock(context(), "/later").then((lock) => { events.push("file"); return lock; });
  await flush();
  assert.deepEqual(events, []);
  assert.equal(manager.activeFileOperationCount, 1);
  dispose(fileHeld);
  await flush();
  assert.deepEqual(events, ["exclusive"]);
  const exclusive = await exclusiveWait;
  assert.equal(manager.activeFileOperationCount, 0);
  dispose(exclusive);
  const file = await laterFile;
  assert.deepEqual(events, ["exclusive", "file"]);
  assert.equal(manager.activeFileOperationCount, 1);
  dispose(file);
  assert.equal(manager.activeFileOperationCount, 0);
});

test("an exclusive lock taken while free blocks file locks until released", async () => {
  const manager = new FileOperationLockManager();
  const exclusive = await manager.waitForExclusiveLock(context());
  let granted: unknown;
  const waiting = manager.waitForLock(context(), "/x").then((lock) => { granted = lock; return lock; });
  await flush();
  assert.equal(granted, undefined);
  dispose(exclusive);
  const file = await waiting;
  assert.equal(granted, file);
  dispose(file);
});

test("a queued exclusive waiter is not granted while any file lock is still held", async () => {
  const manager = new FileOperationLockManager();
  const heldA = await manager.waitForLock(context(), "/a");
  const heldB = await manager.waitForLock(context(), "/b");
  let exclusiveGranted = false;
  const exclusiveWait = manager.waitForExclusiveLock(context()).then((lock) => { exclusiveGranted = true; return lock; });
  await flush();
  assert.equal(exclusiveGranted, false);
  dispose(heldA);
  await flush();
  assert.equal(exclusiveGranted, false);
  dispose(heldB);
  const exclusive = await exclusiveWait;
  assert.equal(exclusiveGranted, true);
  dispose(exclusive);
});

test("a queued exclusive grant keeps the workspace held against new file locks", async () => {
  const manager = new FileOperationLockManager();
  const held = await manager.waitForLock(context(), "/held");
  const exclusiveWait = manager.waitForExclusiveLock(context());
  dispose(held);
  const exclusive = await exclusiveWait;
  let fileGranted = false;
  const waiting = manager.waitForLock(context(), "/after").then((lock) => { fileGranted = true; return lock; });
  await flush();
  assert.equal(fileGranted, false);
  dispose(exclusive);
  const file = await waiting;
  assert.equal(fileGranted, true);
  dispose(file);
});

test("a file lock requested while an exclusive lock is held must wait for it", async () => {
  const manager = new FileOperationLockManager();
  const exclusive = await manager.waitForExclusiveLock(context());
  let granted: unknown;
  const waiting = manager.waitForLock(context(), "/new").then((lock) => { granted = lock; return lock; });
  await flush();
  assert.equal(granted, undefined);
  dispose(exclusive);
  const file = await waiting;
  assert.equal(granted, file);
  dispose(file);
});

test("a queued waiter for a still-held path is not granted when another path is released", async () => {
  const manager = new FileOperationLockManager();
  const heldA = await manager.waitForLock(context(), "/a");
  const heldB = await manager.waitForLock(context(), "/b");
  let granted: unknown;
  const waiting = manager.waitForLock(context(), "/b").then((lock) => { granted = lock; return lock; });
  await flush();
  assert.equal(granted, undefined);
  dispose(heldA);
  await flush();
  assert.equal(granted, undefined);
  assert.equal(manager.activeFileOperationCount, 1);
  dispose(heldB);
  const grantedLock = await waiting;
  assert.equal(granted, grantedLock);
  dispose(grantedLock);
  assert.equal(manager.activeFileOperationCount, 0);
});

test("an already-aborted caller is refused by both entry points", async () => {
  const manager = new FileOperationLockManager();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => manager.waitForLock(context(controller.signal), "/a"), (error: unknown) => (error as Error).message === "Aborted");
  await assert.rejects(() => manager.waitForExclusiveLock(context(controller.signal)), (error: unknown) => (error as Error).message === "Aborted");
  assert.equal(manager.activeFileOperationCount, 0);
});

test("a waiter that is aborted leaves the queue without holding a lock", async () => {
  const manager = new FileOperationLockManager();
  const controller = new AbortController();
  const held = await manager.waitForLock(context(), "/blocking");
  const waiting = manager.waitForLock(context(controller.signal), "/blocking");
  await flush();
  controller.abort();
  await assert.rejects(() => waiting, (error: unknown) => (error as Error).message === "Aborted");
  assert.equal(manager.activeFileOperationCount, 1);
  dispose(held);
  assert.equal(manager.activeFileOperationCount, 0);
});

test("an exclusive waiter that is aborted does not leave the exclusive lock behind", async () => {
  const manager = new FileOperationLockManager();
  const controller = new AbortController();
  const held = await manager.waitForExclusiveLock(context());
  const waiting = manager.waitForExclusiveLock(context(controller.signal));
  await flush();
  controller.abort();
  await assert.rejects(() => waiting, (error: unknown) => (error as Error).message === "Aborted");
  dispose(held);
  const file = await manager.waitForLock(context(), "/after");
  assert.equal(manager.activeFileOperationCount, 1);
  dispose(file);
});

test("a lock granted as the abort arrives is released again", async () => {
  const manager = new FileOperationLockManager();
  const controller = new AbortController();
  const held = await manager.waitForLock(context(), "/x");
  const waiting = manager.waitForLock(context(controller.signal), "/x");
  await flush();
  dispose(held);
  controller.abort();
  await assert.rejects(() => waiting, (error: unknown) => (error as Error).message === "Aborted");
  assert.equal(manager.activeFileOperationCount, 0);
  const next = await manager.waitForLock(context(), "/y");
  assert.equal(manager.activeFileOperationCount, 1);
  dispose(next);
});
