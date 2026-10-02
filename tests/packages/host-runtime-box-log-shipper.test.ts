/**
 * The box's own log, carried where the platform can read it: what is read from which files, what happens to a line
 * before it is sent, when an offset is allowed to move, and what is said about the shipping itself.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  BOX_LOG_SHIP_INTERVAL_MS,
  BOX_LOG_SHIP_PROGRESS_INTERVAL_MS,
  BOX_TELEMETRY_SOURCE,
  BoxLogShipper,
  DEFAULT_EXCLUDED_SOURCE_PREFIXES,
  DEFAULT_LOG_DIR,
  DEFAULT_MAX_BYTES_PER_READ,
  DEFAULT_MAX_LAG_BYTES,
  DEFAULT_MAX_LINES_PER_POLL,
  DEFAULT_MAX_LINE_BYTES,
  DEFAULT_SUBDIR_PATTERN,
  LOG_SUFFIX,
  OFFSETS_FILE_NAME,
  classifyOffsetSaveError,
  isBoxLogShippingEnabled,
  parseBoxInfrastructureEvent,
  saturatingAdd,
  toNonnegativeSafeInteger,
  toSourceName,
  type BoxTelemetryRecord,
} from "../../source/host/telemetry/box-log-shipper.ts";

type ShipperDeps = ConstructorParameters<typeof BoxLogShipper>[0];
type Settlement = "delivered" | "dropped";
type ShipReport = {
  kind: string;
  errorClass?: string;
  failureCount?: number;
  bytesWritten?: number;
  bytesDelivered?: number;
  pendingWindowCount?: number;
  oldestPendingWindowAgeMs?: number;
};

/** A shipper over a real directory, with a clock the test moves and every report it makes written down. */
function harness(
  options: {
    files?: Record<string, string>;
    dirs?: Record<string, Record<string, string>>;
    logDir?: string;
    writeOffsets?: ShipperDeps["writeOffsets"];
    skipNames?: string[];
    maxLinesPerPoll?: number;
    maxLagBytes?: number;
    maxLineBytes?: number;
    maxBytesPerReadPerFile?: number;
    manual?: boolean;
  } = {},
) {
  const logDir = options.logDir ?? mkdtempSync(join(tmpdir(), "slate-log-shipper-"));
  const offsetsPath = join(logDir, OFFSETS_FILE_NAME);
  for (const [name, text] of Object.entries(options.files ?? {})) writeFileSync(join(logDir, name), text, "utf8");
  for (const [name, inner] of Object.entries(options.dirs ?? {})) {
    mkdirSync(join(logDir, name));
    for (const [leaf, text] of Object.entries(inner)) writeFileSync(join(logDir, name, leaf), text, "utf8");
  }
  const batches: BoxTelemetryRecord[][] = [];
  const reports: ShipReport[] = [];
  const listeners: Array<() => Promise<void>> = [];
  // The platform settles a batch one record at a time, so that is how the fake reports it back.
  const batchSettles: Array<{ settle: (settlement: Settlement) => void; count: number }> = [];
  const saveSettles: Array<(settlement: Settlement) => void> = [];
  let monotonic = 1_000;
  let disposed = 0;
  const deps: ShipperDeps = {
    reportBatch: (records, settle) => {
      batches.push(records);
      batchSettles.push({ settle, count: records.length });
    },
    reportBoxLogShip: (report, settle) => {
      reports.push(report);
      if (settle !== undefined) saveSettles.push(settle);
    },
    polling: {
      start: (listener) => {
        listeners.push(listener);
        if (options.manual !== true) void listener();
        return {
          dispose: () => {
            disposed += 1;
          },
        };
      },
    },
    clock: { monotonicNow: () => monotonic },
    logDir,
    offsetsPath,
    ...(options.writeOffsets === undefined ? {} : { writeOffsets: options.writeOffsets }),
    ...(options.skipNames === undefined ? {} : { skipPaths: options.skipNames.map((name) => join(logDir, name)) }),
    ...(options.maxLinesPerPoll === undefined ? {} : { maxLinesPerPoll: options.maxLinesPerPoll }),
    ...(options.maxLagBytes === undefined ? {} : { maxLagBytes: options.maxLagBytes }),
    ...(options.maxLineBytes === undefined ? {} : { maxLineBytes: options.maxLineBytes }),
    ...(options.maxBytesPerReadPerFile === undefined ? {} : { maxBytesPerReadPerFile: options.maxBytesPerReadPerFile }),
  };
  return {
    shipper: new BoxLogShipper(deps),
    logDir,
    offsetsPath,
    batches,
    reports,
    listeners,
    write(name: string, text: string) {
      const path = join(logDir, name);
      writeFileSync(path, text, "utf8");
      return path;
    },
    advance(ms: number) {
      monotonic += ms;
    },
    disposedHandles: () => disposed,
    async waitForListeners() {
      for (let attempt = 0; attempt < 200 && listeners.length === 0; attempt += 1)
        await new Promise((resolve) => setTimeout(resolve, 5));
      return listeners.length;
    },
    settleBatches(settlement: Settlement = "delivered") {
      for (const { settle, count } of batchSettles.splice(0))
        for (let record = 0; record < count; record += 1) settle(settlement);
    },
    settleOneBatchRecord(settlement: Settlement = "delivered") {
      const entry = batchSettles[0];
      if (entry === undefined) return;
      entry.settle(settlement);
      entry.count -= 1;
      if (entry.count <= 0) batchSettles.shift();
    },
    settleSaveReports(settlement: Settlement = "delivered") {
      for (const resolve of saveSettles.splice(0)) resolve(settlement);
    },
    kinds(kind: string) {
      return reports.filter((report) => report.kind === kind);
    },
    linesOf(records: BoxTelemetryRecord[] | undefined) {
      return (records ?? []).map((record) => (record.kind === "log" ? record.line : `[${record.kind}]`));
    },
  };
}

describe("what the box's log shipper reads", () => {
  it("ships what the box wrote, and only what the platform wants", async () => {
    const world = harness({
      files: {
        "host.log": "host line\n",
        "skip-me.log": "not skipped by name\n",
        "slate-notify-injector-9.log": "noise\n",
        "notes.txt": "not a log\n",
      },
      dirs: { "slate-window-3": { "window.log": "window line\n" }, other: { "deep.log": "not ours\n" } },
    });
    const listing = await world.shipper.listLogFiles();
    assert.deepEqual(
      listing.files.map((file) => file.source).sort(),
      ["host", "skip-me", "slate-window-3/window"].sort(),
    );
    assert.equal(listing.complete, true);
    // A source the platform will not take, and one it will.
    assert.equal(world.shipper.isExcludedSource("slate-notify-injector-9"), true);
    assert.equal(world.shipper.isExcludedSource("host"), false);
    assert.deepEqual([...DEFAULT_EXCLUDED_SOURCE_PREFIXES], ["slate-notify-injector"]);
    // A log the shipper was told to skip by path is left alone even though its name is fine.
    const skipping = harness({ files: { "host.log": "host\n", "skip-me.log": "no\n" }, skipNames: ["skip-me.log"] });
    assert.deepEqual((await skipping.shipper.listLogFiles()).files.map((file) => file.source), ["host"]);
    // What a source is called: the suffix is dropped, and nothing else is.
    assert.equal(toSourceName(`host${LOG_SUFFIX}`), "host");
    assert.equal(toSourceName("host"), "host");
    assert.equal(toSourceName("a.log.log"), "a.log");
    // A directory that is not there at all is not a complete listing.
    const gone = harness();
    rmSync(gone.logDir, { recursive: true, force: true });
    assert.deepEqual(await gone.shipper.listLogFiles(), { files: [], complete: false });
  });

  it("turns a line into what the platform takes, and leaves out what it cannot read", () => {
    const world = harness();
    assert.deepEqual(world.shipper.toTelemetryRecord({ source: "host", line: "one" }), {
      kind: "log",
      source: "host",
      line: "one",
    });
    // The telemetry source carries an event rather than a line, when the line can be read as one.
    const event = { kind: "boot_stage", stage: "ready", durationMs: 5 };
    assert.deepEqual(world.shipper.toTelemetryRecord({ source: BOX_TELEMETRY_SOURCE, line: JSON.stringify(event) }), {
      kind: "infrastructure",
      event,
    });
    assert.equal(world.shipper.toTelemetryRecord({ source: BOX_TELEMETRY_SOURCE, line: "{not json" }), undefined);
    assert.equal(
      world.shipper.toTelemetryRecord({ source: BOX_TELEMETRY_SOURCE, line: JSON.stringify({ kind: "not-a-stage" }) }),
      undefined,
    );
    // Which events are readable at all, and which are not what they claim to be.
    assert.deepEqual(parseBoxInfrastructureEvent(event), event);
    assert.deepEqual(parseBoxInfrastructureEvent({ kind: "process_crash", binary: "node", signal: "sigsegv", count: 2 }), {
      kind: "process_crash",
      binary: "node",
      signal: "sigsegv",
      count: 2,
    });
    assert.deepEqual(parseBoxInfrastructureEvent({ kind: "egress_tunnel", outcome: "ready", attempt: 1 }), {
      kind: "egress_tunnel",
      outcome: "ready",
      attempt: 1,
    });
    assert.equal(parseBoxInfrastructureEvent({ kind: "boot_stage", stage: "ready" }), undefined);
    assert.equal(
      parseBoxInfrastructureEvent({ kind: "process_crash", binary: "node", signal: "sigsegv", count: 0 }),
      undefined,
    );
    assert.equal(parseBoxInfrastructureEvent(undefined), undefined);
  });

  it("ships a file's new lines in one batch, and moves the offset only once the batch has arrived", async () => {
    const world = harness({ files: { "host.log": "one\ntwo\nthree" } });
    const path = join(world.logDir, "host.log");
    await world.shipper.pollOnce();
    assert.deepEqual(world.linesOf(world.batches[0]), ["one", "two"]);
    // The last line has no newline yet: it is not shipped, and the offset has not moved while the batch is in flight.
    assert.equal(world.shipper.offsets.get(path), undefined);
    assert.equal(world.shipper.pendingDeliveryWindows.size, 1);
    await world.shipper.pollOnce();
    assert.equal(world.batches.length, 1);
    // One record arriving is not the whole window: it stays open until every record has been settled.
    world.settleOneBatchRecord();
    assert.equal(world.shipper.pendingDeliveryWindows.size, 1);
    assert.equal(world.shipper.offsets.get(path), undefined);
    world.settleOneBatchRecord();
    assert.equal(world.shipper.pendingDeliveryWindows.size, 0);
    assert.equal(world.shipper.offsets.get(path), "one\ntwo\n".length);
    world.write("host.log", "one\ntwo\nthree\nfour\n");
    await world.shipper.pollOnce();
    assert.deepEqual(world.linesOf(world.batches[1]), ["three", "four"]);
    world.settleBatches();
    assert.equal(world.shipper.offsets.get(path), "one\ntwo\nthree\nfour\n".length);
    // What did not arrive is shipped again rather than being skipped.
    const dropped = harness({ files: { "host.log": "again\n" } });
    await dropped.shipper.pollOnce();
    dropped.settleBatches("dropped");
    assert.equal(dropped.shipper.offsets.get(join(dropped.logDir, "host.log")), undefined);
    await dropped.shipper.pollOnce();
    assert.deepEqual(dropped.linesOf(dropped.batches[1]), ["again"]);
  });

  it("keeps a file it has fallen too far behind on from holding up the rest", async () => {
    const behind = harness({
      files: { "host.log": `${"a".repeat(8)}\n${"a".repeat(9)}\n${"a".repeat(9)}\n` },
      maxLagBytes: 10,
      maxBytesPerReadPerFile: 8,
    });
    const behindPath = join(behind.logDir, "host.log");
    await behind.shipper.pollOnce();
    // The catch-up line says how far behind it was, and only the last readable window is shipped.
    assert.deepEqual(behind.linesOf(behind.batches[0]), [
      "[slate-log-shipper] skipped 21 bytes (too far behind)",
      "a".repeat(7),
    ]);
    behind.settleBatches();
    assert.equal(behind.shipper.offsets.get(behindPath), 29);
    // A line longer than the platform takes is cut rather than shipped whole, from a read window with no newline in it.
    const long = harness({ files: { "host.log": "abcdefghij" }, maxBytesPerReadPerFile: 8, maxLineBytes: 4 });
    await long.shipper.pollOnce();
    assert.deepEqual(long.linesOf(long.batches[0]), ["abcd"]);
    long.settleBatches();
    assert.equal(long.shipper.offsets.get(join(long.logDir, "host.log")), 8);
    await long.shipper.pollOnce();
    assert.equal(long.batches.length, 1);
    // A poll never ships more than its budget of lines, and the rest waits for the next one.
    const budget = harness({ files: { "host.log": "one\ntwo\nthree\nfour\n" }, maxLinesPerPoll: 2 });
    await budget.shipper.pollOnce();
    assert.deepEqual(budget.linesOf(budget.batches[0]), ["one", "two"]);
    budget.settleBatches();
    await budget.shipper.pollOnce();
    assert.deepEqual(budget.linesOf(budget.batches[1]), ["three", "four"]);
  });

  it("reads a line as the line it is: a carriage return is not part of it, and an empty line is not a line", async () => {
    const world = harness({ files: { "host.log": "one\r\n\ntwo\r\n" } });
    const path = join(world.logDir, "host.log");
    await world.shipper.pollOnce();
    assert.deepEqual(world.linesOf(world.batches[0]), ["one", "two"]);
    world.settleBatches();
    assert.equal(world.shipper.offsets.get(path), 11);
    // What has already been read is not read again.
    await world.shipper.pollOnce();
    assert.equal(world.batches.length, 1);
  });

  it("starts over a file that was truncated rather than shipping what is no longer there", async () => {
    const world = harness({ files: { "host.log": "first line\nsecond line\n" } });
    const path = join(world.logDir, "host.log");
    await world.shipper.pollOnce();
    world.settleBatches();
    assert.equal(world.shipper.offsets.get(path), 23);
    writeFileSync(path, "short\n", "utf8");
    await world.shipper.pollOnce();
    // What is left of the file is read again from the beginning, and its offset moves when that arrives.
    assert.deepEqual(world.linesOf(world.batches[1]), ["short"]);
    assert.equal(world.shipper.offsets.get(path), 0);
    world.settleBatches();
    assert.equal(world.shipper.offsets.get(path), 6);
    // A window that was already on its way when the file changed is invalidated rather than allowed to move the offset.
    const flight = harness({ files: { "host.log": "abc\ndef\n" } });
    const flightPath = join(flight.logDir, "host.log");
    await flight.shipper.pollOnce();
    flight.settleBatches();
    assert.equal(flight.shipper.offsets.get(flightPath), 8);
    flight.write("host.log", "abc\ndef\nghi\n");
    await flight.shipper.pollOnce();
    const window = flight.shipper.pendingDeliveryWindows.get(flightPath);
    assert.notEqual(window, undefined);
    writeFileSync(flightPath, "xy\n", "utf8");
    await flight.shipper.pollOnce();
    assert.equal(window?.invalidated, true);
    assert.equal(flight.shipper.offsets.get(flightPath), 0);
    flight.settleBatches();
    assert.equal(flight.shipper.offsets.get(flightPath), 0);
    await flight.shipper.pollOnce();
    flight.settleBatches();
    assert.deepEqual(flight.linesOf(flight.batches[2]), ["xy"]);
    assert.equal(flight.shipper.offsets.get(flightPath), 3);
  });

  it("rewinds an offset that is ahead of the file and leaves one that is not", () => {
    const world = harness();
    world.shipper.setOffset("/x.log", 10);
    world.shipper.reconcileTruncatedOffsets([{ path: "/x.log", source: "x", size: 10 }]);
    assert.equal(world.shipper.offsets.get("/x.log"), 10);
    world.shipper.reconcileTruncatedOffsets([{ path: "/x.log", source: "x", size: 5 }]);
    assert.equal(world.shipper.offsets.get("/x.log"), 0);
    // With a window still open, the file is marked as no longer the one the window was read from.
    const openWindow = { candidateEndOffset: 20, unsettledRecordCount: 1, didDropRecord: false, invalidated: false };
    world.shipper.setOffset("/y.log", 15);
    world.shipper.pendingDeliveryWindows.set("/y.log", openWindow);
    world.shipper.reconcileTruncatedOffsets([{ path: "/y.log", source: "y", size: 4 }]);
    assert.equal(openWindow.invalidated, true);
    assert.equal(world.shipper.offsets.get("/y.log"), 0);
    world.shipper.settleDeliveryWindow("/y.log", openWindow, "delivered");
    assert.equal(world.shipper.offsets.get("/y.log"), 0);
    assert.equal(world.shipper.pendingDeliveryWindows.size, 0);
  });

  it("reads only what is new in a file, and measures the files it can", async () => {
    const world = harness({ files: { "host.log": "abc" } });
    const path = join(world.logDir, "host.log");
    const measured = await world.shipper.snapshotLogFileSizes({
      files: [{ path, source: "host" }],
      complete: true,
    });
    assert.deepEqual(measured, { files: [{ path, source: "host", size: 3 }], complete: true });
    // A file that is not there is not treated as noise; one the shipper cannot reach is named once and left alone.
    const logged: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(String(args[0]));
    };
    let absent;
    let broken;
    try {
      const missing = join(world.logDir, "gone.log");
      absent = await world.shipper.snapshotLogFileSizes({ files: [{ path: missing, source: "gone" }], complete: true });
      assert.equal(world.shipper.statFailedPaths.has(missing), false);
      const nested = join(world.logDir, "host.log", "inner.log");
      broken = await world.shipper.snapshotLogFileSizes({ files: [{ path: nested, source: "inner" }], complete: true });
      const again = await world.shipper.snapshotLogFileSizes({ files: [{ path: nested, source: "inner" }], complete: true });
      assert.equal(again.complete, false);
    } finally {
      console.error = originalError;
    }
    assert.deepEqual(absent, { files: [], complete: false });
    assert.deepEqual(broken, { files: [], complete: false });
    assert.equal(world.shipper.statFailedPaths.has(join(world.logDir, "host.log", "inner.log")), true);
    assert.equal(logged.filter((line) => line.includes("stat failed")).length, 1);
    // A listing that was already incomplete stays incomplete.
    assert.equal((await world.shipper.snapshotLogFileSizes({ files: [], complete: false })).complete, false);
    // A file with nothing new, or one whose window is still open, is not read.
    const quiet = harness({ files: { "host.log": "ab\n" } });
    const quietPath = join(quiet.logDir, "host.log");
    quiet.shipper.setOffset(quietPath, 3);
    quiet.shipper.pendingWindowStartedAtMs.set(quietPath, 7);
    assert.equal(await quiet.shipper.pumpFile({ path: quietPath, source: "host", size: 3 }, 10), 0);
    assert.equal(quiet.shipper.pendingWindowStartedAtMs.has(quietPath), false);
    quiet.shipper.pendingDeliveryWindows.set(quietPath, {
      candidateEndOffset: 3,
      unsettledRecordCount: 1,
      didDropRecord: false,
      invalidated: false,
    });
    quiet.shipper.setOffset(quietPath, 0);
    assert.equal(await quiet.shipper.pumpFile({ path: quietPath, source: "host", size: 3 }, 10), 0);
    assert.equal(quiet.batches.length, 0);
  });
});

describe("what the shipper remembers and reports", () => {
  it("remembers what it has shipped, and starts from there", async () => {
    const world = harness({ files: { "host.log": "one\n" } });
    const path = join(world.logDir, "host.log");
    await world.shipper.start();
    assert.equal(world.batches.length, 1);
    world.settleBatches();
    assert.equal(world.shipper.offsets.get(path), 4);
    await world.shipper.saveOffsets();
    assert.deepEqual(JSON.parse(readFileSync(world.offsetsPath, "utf8")), { [path]: 4 });
    // A later shipper over the same directory picks up where the first one left off.
    const later = harness({ logDir: world.logDir });
    await later.shipper.start();
    assert.equal(later.shipper.offsets.get(path), 4);
    assert.equal(later.batches.length, 0);
    // Nothing is written before the offsets were ever loaded, and a clean save writes nothing unless it is forced.
    const unloaded = harness({ files: { "host.log": "one\n" } });
    await unloaded.shipper.pollOnce();
    unloaded.settleBatches();
    await unloaded.shipper.saveOffsets();
    assert.equal(existsSync(unloaded.offsetsPath), false);
    const forced = harness();
    await forced.shipper.start();
    await forced.shipper.checkpointOffsets();
    assert.deepEqual(JSON.parse(readFileSync(forced.offsetsPath, "utf8")), {});
    assert.equal(forced.kinds("save_recovered").length, 0);
    // A file that cannot be read as offsets, and one that says nothing usable, are both left alone.
    const broken = harness();
    writeFileSync(broken.offsetsPath, "{not json", "utf8");
    await broken.shipper.loadOffsets();
    assert.equal(broken.shipper.offsets.size, 0);
    writeFileSync(broken.offsetsPath, JSON.stringify({ "/x.log": "not a number", "/y.log": -1 }), "utf8");
    await broken.shipper.loadOffsets();
    assert.equal(broken.shipper.offsets.size, 0);
    writeFileSync(broken.offsetsPath, JSON.stringify({ "/x.log": 3 }), "utf8");
    await broken.shipper.loadOffsets();
    assert.equal(broken.shipper.offsets.get("/x.log"), 3);
  });

  it("says when an offset could not be saved, and says when it was saved again", async () => {
    let failing = true;
    const world = harness({
      files: { "host.log": "one\n" },
      writeOffsets: async (path, data) => {
        if (failing) throw Object.assign(new Error("no space"), { code: "ENOSPC" });
        writeFileSync(path, Buffer.from(data));
      },
    });
    await world.shipper.start();
    world.settleBatches();
    await world.shipper.checkpointOffsets();
    assert.deepEqual(
      world.kinds("save_failed").map((report) => [report.errorClass, report.failureCount]),
      [["no_space", 1]],
    );
    // The platform did not take the report: a retry is due one progress interval from now.
    world.settleSaveReports("dropped");
    world.advance(BOX_LOG_SHIP_PROGRESS_INTERVAL_MS - 1);
    world.shipper.maybeRetryOffsetSaveFailure();
    assert.equal(world.kinds("save_failed").length, 1);
    // Failing again while waiting is counted rather than reported twice.
    await world.shipper.checkpointOffsets();
    assert.equal(world.kinds("save_failed").length, 1);
    world.advance(1);
    world.shipper.maybeRetryOffsetSaveFailure();
    assert.deepEqual(
      world.kinds("save_failed").map((report) => [report.errorClass, report.failureCount]),
      [
        ["no_space", 1],
        ["no_space", 2],
      ],
    );
    world.shipper.maybeRetryOffsetSaveFailure();
    assert.equal(world.kinds("save_failed").length, 2);
    // A report the platform took is not reported again.
    world.settleSaveReports("delivered");
    world.advance(BOX_LOG_SHIP_PROGRESS_INTERVAL_MS);
    world.shipper.maybeRetryOffsetSaveFailure();
    assert.equal(world.kinds("save_failed").length, 2);
    // Saving that works says the offsets are being kept again.
    failing = false;
    await world.shipper.checkpointOffsets();
    assert.deepEqual(
      world.kinds("save_recovered").map((report) => [report.errorClass, report.failureCount]),
      [["no_space", 2]],
    );
    assert.deepEqual(JSON.parse(readFileSync(world.offsetsPath, "utf8")), { [join(world.logDir, "host.log")]: 4 });
  });

  it("reports how much of the log has been shipped, as often as the platform wants to hear it", async () => {
    const world = harness({ files: { "host.log": "one\ntwo\n" } });
    const path = join(world.logDir, "host.log");
    await world.shipper.pollOnce();
    assert.deepEqual(world.kinds("progress")[0], {
      kind: "progress",
      bytesWritten: 8,
      bytesDelivered: 0,
      pendingWindowCount: 1,
      oldestPendingWindowAgeMs: 0,
    });
    world.settleBatches();
    world.advance(BOX_LOG_SHIP_PROGRESS_INTERVAL_MS - 1);
    await world.shipper.pollOnce();
    assert.equal(world.kinds("progress").length, 1);
    world.advance(1);
    await world.shipper.pollOnce();
    assert.deepEqual(world.kinds("progress")[1], {
      kind: "progress",
      bytesWritten: 8,
      bytesDelivered: 8,
      pendingWindowCount: 0,
      oldestPendingWindowAgeMs: 0,
    });
    assert.equal(world.shipper.offsets.get(path), 8);
    // A window that stays open is reported by how long it has been open.
    const pending = harness({ files: { "host.log": "one\n" } });
    await pending.shipper.pollOnce();
    pending.advance(BOX_LOG_SHIP_PROGRESS_INTERVAL_MS);
    await pending.shipper.pollOnce();
    assert.deepEqual(pending.kinds("progress")[1], {
      kind: "progress",
      bytesWritten: 4,
      bytesDelivered: 0,
      pendingWindowCount: 1,
      oldestPendingWindowAgeMs: BOX_LOG_SHIP_PROGRESS_INTERVAL_MS,
    });
  });
});

describe("when the shipper runs and when it stops", () => {
  it("starts by remembering where it got to, and cannot be polling twice at once", async () => {
    const world = harness({ files: { "host.log": "one\n" }, manual: true });
    let started = false;
    const starting = world.shipper.start();
    void starting.then(() => {
      started = true;
    });
    assert.equal(await world.waitForListeners(), 1);
    assert.equal(started, false);
    await world.listeners[0]?.();
    await starting;
    assert.equal(started, true);
    assert.equal(world.batches.length, 1);
    // A second poll while the first is still running does nothing.
    const overlap = harness({ files: { "host.log": "one\ntwo\n" } });
    await Promise.all([overlap.shipper.poll(), overlap.shipper.poll()]);
    assert.equal(overlap.batches.length, 1);
    // A shipper that never started polling still reads when it is asked to.
    const asked = harness({ files: { "host.log": "one\n" } });
    await asked.shipper.poll();
    assert.equal(asked.batches.length, 1);
  });

  it("stops without leaving a poll behind, and keeps what it knows", async () => {
    const world = harness({ files: { "host.log": "one\n" }, manual: true });
    const starting = world.shipper.start();
    assert.equal(await world.waitForListeners(), 1);
    await world.listeners[0]?.();
    await starting;
    world.settleBatches();
    const path = join(world.logDir, "host.log");
    world.write("host.log", "one\ntwo\n");
    await world.shipper.stopPolling();
    assert.equal(world.disposedHandles(), 1);
    const shipped = world.batches.length;
    await world.shipper.poll();
    assert.equal(world.batches.length, shipped);
    await world.shipper.dispose();
    assert.deepEqual(JSON.parse(readFileSync(world.offsetsPath, "utf8")), { [path]: 4 });
  });
});

describe("the numbers and answers the shipper works with", () => {
  it("counts what it reports, and classifies what went wrong with the filesystem", () => {
    assert.deepEqual(
      [DEFAULT_LOG_DIR, LOG_SUFFIX, OFFSETS_FILE_NAME, BOX_TELEMETRY_SOURCE],
      ["/tmp", ".log", "slate-log-shipper.offsets.json", "slate-box-telemetry"],
    );
    assert.deepEqual(
      [
        BOX_LOG_SHIP_INTERVAL_MS,
        BOX_LOG_SHIP_PROGRESS_INTERVAL_MS,
        DEFAULT_MAX_BYTES_PER_READ,
        DEFAULT_MAX_LINES_PER_POLL,
        DEFAULT_MAX_LAG_BYTES,
        DEFAULT_MAX_LINE_BYTES,
      ],
      [2_000, 300_000, 262_144, 1_000, 16_777_216, 65_536],
    );
    assert.equal(DEFAULT_SUBDIR_PATTERN.test("slate-window-1"), true);
    assert.equal(DEFAULT_SUBDIR_PATTERN.test("other"), false);
    // Shipping only happens inside a box, and can be turned off there.
    assert.equal(isBoxLogShippingEnabled({}), false);
    assert.equal(isBoxLogShippingEnabled({ SLATE_HOST_IN_BOX: "true" }), false);
    assert.equal(isBoxLogShippingEnabled({ SLATE_HOST_IN_BOX: "1" }), true);
    for (const disabled of ["1", "true", "yes", " TRUE ", "Yes"])
      assert.equal(isBoxLogShippingEnabled({ SLATE_HOST_IN_BOX: "1", SLATE_BOX_LOG_SHIP_DISABLED: disabled }), false);
    assert.equal(isBoxLogShippingEnabled({ SLATE_HOST_IN_BOX: "1", SLATE_BOX_LOG_SHIP_DISABLED: "no" }), true);
    // What is counted is rounded away from nonsense, kept non-negative, and capped rather than overflowing.
    assert.equal(toNonnegativeSafeInteger(2.4), 2);
    assert.equal(toNonnegativeSafeInteger(2.5), 3);
    assert.equal(toNonnegativeSafeInteger(-5), 0);
    assert.equal(toNonnegativeSafeInteger(Number.POSITIVE_INFINITY), Number.MAX_SAFE_INTEGER);
    assert.equal(toNonnegativeSafeInteger(Number.NaN), Number.MAX_SAFE_INTEGER);
    assert.equal(saturatingAdd(2, 3), 5);
    assert.equal(saturatingAdd(2, -3), 2);
    assert.equal(saturatingAdd(Number.MAX_SAFE_INTEGER - 1, 5), Number.MAX_SAFE_INTEGER);
    assert.equal(saturatingAdd(0, Number.NaN), Number.MAX_SAFE_INTEGER);
    // The failure the system reported, even when it was wrapped on the way up.
    const err = (code?: string) => Object.assign(new Error("x"), code === undefined ? {} : { code });
    assert.equal(classifyOffsetSaveError(err("ENOSPC")), "no_space");
    assert.equal(classifyOffsetSaveError(err("EDQUOT")), "no_space");
    assert.equal(classifyOffsetSaveError(err("EACCES")), "permission_denied");
    assert.equal(classifyOffsetSaveError(err("EPERM")), "permission_denied");
    assert.equal(classifyOffsetSaveError(err("EROFS")), "read_only");
    assert.equal(classifyOffsetSaveError(err("ENOENT")), "missing_parent");
    assert.equal(classifyOffsetSaveError(err("EIO")), "io");
    assert.equal(classifyOffsetSaveError(err()), "unknown");
    assert.equal(classifyOffsetSaveError(new Error("plain")), "unknown");
    assert.equal(classifyOffsetSaveError(Object.assign(new Error("wrapped"), { cause: err("ENOSPC") })), "no_space");
    assert.equal(toSourceName("notes.txt"), "notes.txt");
  });
});
