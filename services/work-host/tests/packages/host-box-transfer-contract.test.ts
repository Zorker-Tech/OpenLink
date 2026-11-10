import assert from "node:assert/strict";
import { setTimeout as wait } from "node:timers/promises";
import { test } from "node:test";

import {
  BOX_PATH_ROOTS,
  BoxFileUnreadableError,
  BoxTransferError,
  DEFAULT_BOX_TRANSFER_CONCURRENCY,
  DEFAULT_BOX_TRANSFER_MAX_BYTES,
  forEachBounded,
  forEachWavePipelined,
  downloadBoxFiles,
  isBoxRootPath,
  isSourceMissingError,
  resolveBoxWorkspacePath,
  SLATE_BOX_UPLOADS_DIR,
  SLATE_BOX_WORKSPACE_ROOT,
  transferFileBetweenBoxes,
  uploadBoxFiles,
  type TransferBox,
} from "../../source/host/boxes/box-transfer.ts";

function box(handlers: {
  download?: (agentId: string, path: string) => Promise<Uint8Array>;
  upload?: (agentId: string, path: string, data: Uint8Array) => Promise<void>;
} = {}) {
  const downloads: Array<[string, string]> = [];
  const uploads: Array<[string, string, Uint8Array]> = [];
  const value: TransferBox = {
    downloadFile: async (_ctx, agentId, path) => {
      downloads.push([agentId, path]);
      return handlers.download?.(agentId, path) ?? new Uint8Array([1, 2, 3]);
    },
    uploadFile: async (_ctx, agentId, path, data) => {
      uploads.push([agentId, path, data]);
      await handlers.upload?.(agentId, path, data);
    },
  };
  return { value, downloads, uploads };
}

function transferEndpoints(source: TransferBox, destination: TransferBox) {
  return {
    source: { box: source, agentId: "source-agent", path: "/workspace/from.txt", label: "source box" },
    dest: { box: destination, agentId: "dest-agent", path: "/workspace/to.txt", label: "destination box" },
  };
}

test("box transfer paths are resolved with POSIX workspace rules and the allowed roots stay explicit", () => {
  assert.deepEqual(BOX_PATH_ROOTS, ["/workspace", "/home", "/root"]);
  assert.deepEqual([SLATE_BOX_UPLOADS_DIR, SLATE_BOX_WORKSPACE_ROOT], ["/workspace/uploads", "/workspace"]);
  assert.equal(isBoxRootPath("/workspace"), true);
  assert.equal(isBoxRootPath("/workspace/file.txt"), true);
  assert.equal(isBoxRootPath("/home/user"), true);
  assert.equal(isBoxRootPath("/root/file"), true);
  assert.equal(isBoxRootPath("/workspaces/file"), false);
  assert.equal(isBoxRootPath("/etc/passwd"), false);
  assert.equal(resolveBoxWorkspacePath("folder/../file.txt"), "/workspace/file.txt");
  assert.equal(resolveBoxWorkspacePath("/home/user/file.txt"), "/home/user/file.txt");
  assert.equal(resolveBoxWorkspacePath("/workspace/a/../b"), "/workspace/b");
  assert.equal(resolveBoxWorkspacePath("../../etc/passwd"), "/etc/passwd");
});

test("transfer limits and missing-file classification are stable", () => {
  assert.deepEqual([DEFAULT_BOX_TRANSFER_MAX_BYTES, DEFAULT_BOX_TRANSFER_CONCURRENCY], [256 * 1024 * 1024, 4]);
  assert.deepEqual([new BoxTransferError("x").name, new BoxFileUnreadableError("x").name], ["BoxTransferError", "BoxFileUnreadableError"]);
  assert.equal(isSourceMissingError(new BoxFileUnreadableError("missing")), true);
  assert.equal(isSourceMissingError(Object.assign(new Error("gone"), { code: "ENOENT" })), true);
  assert.equal(isSourceMissingError(new Error("no such file or directory: /workspace/a")), true);
  assert.equal(isSourceMissingError(new Error("error code ENOENT from provider")), true);
  assert.equal(isSourceMissingError(new Error("permission denied")), false);
  assert.equal(isSourceMissingError("ENOENT"), true);
});

test("transfer reads the source, writes the destination and returns the byte count", async () => {
  const source = box({ download: async () => new Uint8Array([4, 5, 6, 7]) });
  const destination = box();
  const ctx = { request: "context" };
  const size = await transferFileBetweenBoxes(ctx, transferEndpoints(source.value, destination.value));
  assert.equal(size, 4);
  assert.deepEqual(source.downloads, [["source-agent", "/workspace/from.txt"]]);
  assert.deepEqual(destination.uploads, [["dest-agent", "/workspace/to.txt", new Uint8Array([4, 5, 6, 7])]]);
});

test("a missing source file becomes an actionable error with its cause", async () => {
  const sourceFailure = new BoxFileUnreadableError("file unreadable");
  const source = box({ download: async () => { throw sourceFailure; } });
  const destination = box();
  await assert.rejects(
    () => transferFileBetweenBoxes({}, transferEndpoints(source.value, destination.value)),
    (error: unknown) => error instanceof BoxTransferError
      && error.message === "source file not found on source box: /workspace/from.txt"
      && error.cause === sourceFailure,
  );
  assert.equal(destination.uploads.length, 0);
});

test("other read and write failures identify their respective box and keep the cause", async () => {
  const readFailure = new Error("offline");
  const failedSource = box({ download: async () => { throw readFailure; } });
  await assert.rejects(
    () => transferFileBetweenBoxes({}, transferEndpoints(failedSource.value, box().value)),
    (error: unknown) => error instanceof BoxTransferError
      && error.message === "failed to read /workspace/from.txt from source box: offline"
      && error.cause === readFailure,
  );

  const writeFailure = new Error("quota exceeded");
  const destination = box({ upload: async () => { throw writeFailure; } });
  await assert.rejects(
    () => transferFileBetweenBoxes({}, transferEndpoints(box().value, destination.value)),
    (error: unknown) => error instanceof BoxTransferError
      && error.message === "failed to write /workspace/to.txt on destination box: quota exceeded"
      && error.cause === writeFailure,
  );
});

test("a transfer accepts a file exactly at its limit and refuses a larger file before upload", async () => {
  const source = box({ download: async () => new Uint8Array([1, 2, 3]) });
  const destination = box();
  assert.equal(await transferFileBetweenBoxes({}, { ...transferEndpoints(source.value, destination.value), maxBytes: 3 }), 3);
  assert.equal(destination.uploads.length, 1);

  const oversizedSource = box({ download: async () => new Uint8Array([1, 2, 3, 4]) });
  const untouchedDestination = box();
  await assert.rejects(
    () => transferFileBetweenBoxes({}, { ...transferEndpoints(oversizedSource.value, untouchedDestination.value), maxBytes: 3 }),
    (error: unknown) => error instanceof BoxTransferError && error.message.includes("4 bytes, over the 3-byte limit"),
  );
  assert.equal(untouchedDestination.uploads.length, 0);
});

test("bounded iteration keeps input order and never exceeds its concurrency limit", async () => {
  const calls: number[] = [];
  let active = 0;
  let peak = 0;
  await forEachBounded([1, 2, 3, 4, 5], 2, async (item) => {
    calls.push(item);
    active += 1;
    peak = Math.max(peak, active);
    await wait(item === 1 ? 4 : 1);
    active -= 1;
  });
  assert.deepEqual(calls, [1, 2, 3, 4, 5]);
  assert.equal(peak, 2);
});

test("bounded iteration clamps a zero limit and handles an empty input", async () => {
  const calls: number[] = [];
  await forEachBounded([1, 2], 0, async (item) => { calls.push(item); });
  await forEachBounded([], 10, async (item) => { calls.push(item); });
  assert.deepEqual(calls, [1, 2]);
});

test("bounded iteration stops assigning new work after a worker fails", async () => {
  const calls: number[] = [];
  await assert.rejects(forEachBounded([1, 2, 3, 4], 2, async (item) => {
    calls.push(item);
    if (item === 1) throw new Error("stop");
    await wait(1);
  }), /stop/);
  await wait(2);
  assert.equal(calls.includes(3), false);
  assert.equal(calls.includes(4), false);
});

test("wave processing prepares chunks and processes them under its concurrency cap", async () => {
  const waves: number[][] = [];
  const processed: number[] = [];
  let active = 0;
  let peak = 0;
  await forEachWavePipelined([0, 1, 2, 3, 4, 5, 6], {
    waveSize: 3,
    concurrency: 2,
    prepareWave: async (wave) => { waves.push([...wave]); return wave.map((item) => item * 10); },
    process: async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await wait(1);
      processed.push(value);
      active -= 1;
    },
  });
  assert.deepEqual(waves, [[0, 1, 2], [3, 4, 5], [6]]);
  assert.deepEqual(processed.sort((left, right) => left - right), [0, 10, 20, 30, 40, 50, 60]);
  assert.equal(peak, 2);
});

test("wave processing clamps its wave and worker counts and accepts no work", async () => {
  const processed: number[] = [];
  await forEachWavePipelined([1, 2, 3], {
    waveSize: 0,
    concurrency: 0,
    prepareWave: async (wave) => wave,
    process: async (item) => { processed.push(item); },
  });
  await forEachWavePipelined([], {
    waveSize: 4,
    concurrency: 4,
    prepareWave: async (wave) => wave,
    process: async (item) => { processed.push(item); },
  });
  assert.deepEqual(processed, [1, 2, 3]);
});

test("wave workers process prepared values in queue order when concurrency is one", async () => {
  const processed: number[] = [];
  await forEachWavePipelined([1, 2, 3, 4], {
    waveSize: 3,
    concurrency: 1,
    prepareWave: async (wave) => wave,
    process: async (item) => { processed.push(item); },
  });
  assert.deepEqual(processed, [1, 2, 3, 4]);
});

test("wave preparation and processing failures reach the caller", async () => {
  await assert.rejects(forEachWavePipelined([1, 2], {
    waveSize: 1,
    concurrency: 2,
    prepareWave: async (wave) => { if (wave[0] === 1) throw new Error("prepare failed"); return wave; },
    process: async () => {},
  }), /prepare failed/);
  await assert.rejects(forEachWavePipelined([1, 2, 3], {
    waveSize: 3,
    concurrency: 1,
    prepareWave: async (wave) => wave,
    process: async (item) => { if (item === 1) throw new Error("process failed"); },
  }), /process failed/);
});

test("downloads are deduplicated and returned in the first-seen path order", async () => {
  const downloadBox = box({ download: async (_agentId, path) => {
    await wait(path === "slow" ? 3 : 0);
    return new TextEncoder().encode(path);
  } });
  const files = await downloadBoxFiles({}, downloadBox.value, "agent-a", ["slow", "fast", "slow"], { maxConcurrency: 2 });
  assert.deepEqual(downloadBox.downloads, [["agent-a", "slow"], ["agent-a", "fast"]]);
  assert.deepEqual([...files.keys()], ["slow", "fast"]);
  assert.deepEqual([...files.values()].map((bytes) => new TextDecoder().decode(bytes)), ["slow", "fast"]);
});

test("a download batch refuses a path whose file read produced no bytes", async () => {
  const empty = {
    downloadFile: async () => undefined as unknown as Uint8Array,
    uploadFile: async () => {},
  };
  await assert.rejects(() => downloadBoxFiles({}, empty, "agent", ["empty"]), /download from box empty produced no bytes/);
});

test("upload paths are deduplicated using the first data row and keep input order", async () => {
  const uploadBox = box();
  const uploaded = await uploadBoxFiles({}, uploadBox.value, "agent-b", [
    { boxPath: "a", data: new Uint8Array([1]) },
    { boxPath: "b", data: new Uint8Array([2]) },
    { boxPath: "a", data: new Uint8Array([9]) },
  ], { maxConcurrency: 2 });
  assert.deepEqual(uploaded, ["a", "b"]);
  assert.deepEqual(uploadBox.uploads, [
    ["agent-b", "a", new Uint8Array([1])],
    ["agent-b", "b", new Uint8Array([2])],
  ]);
});
