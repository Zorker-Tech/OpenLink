/**
 * The resources a box offers the runner, the action audit and the content search service.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BoxNotReadyError, createRemoteBoxResourceAccessor } from "../../source/host/runner/remote-box-resources.ts";
import { computerUseAuditKind, IGNORED_URL_PREFIXES, NAVIGATION_PROBE_CDP_BASE_PORT, NAVIGATION_PROBE_MIN_INTERVAL_MS } from "../../source/host/runner/slate-action-audit.ts";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MAX_FAILED_JOB_RECONCILES, MAX_INDEX_REBUILDS, MAX_WORKER_RESPAWNS, SEARCH_INDEX_DISPOSE_TIMEOUT_MS, SlateSearchIndexService, WorkerSearchIndexJobPort, defaultWorkerEntryPath } from "../../source/host/extensions/content-search/search-index-service.ts";
import { ensureSearchIndexSchema, openSearchIndexDb, stampSearchIndexSchemaVersion, writeReconcileDone } from "../../source/host/extensions/content-search/search-index-db.ts";

describe("the resources a box offers the runner", () => {
  it("names the error a box that is not up yet raises, and builds the accessor", () => {
    assert.equal(new BoxNotReadyError().name, "BoxNotReadyError");
    assert.equal(typeof createRemoteBoxResourceAccessor, "function");
  });
});

describe("auditing what an agent did", () => {
  it("knows which page visits are not probed, and how often a probe may run", () => {
    assert.equal(NAVIGATION_PROBE_CDP_BASE_PORT > 0, true);
    assert.equal(NAVIGATION_PROBE_MIN_INTERVAL_MS > 0, true);
    assert.equal(Array.isArray(IGNORED_URL_PREFIXES), true);
    assert.equal(typeof computerUseAuditKind, "function");
  });
});

describe("the content search, as a service", () => {
  const ok = () => ({ ok: true as const });
  const workerUnavailable = (message: string) => ({ ok: false as const, message, isIndexCorrupt: false, isWorkerUnavailable: true });
  const corrupt = (message: string) => ({ ok: false as const, message, isIndexCorrupt: true, isWorkerUnavailable: false });
  const failed = (message: string) => ({ ok: false as const, message, isIndexCorrupt: false, isWorkerUnavailable: false });
  const indexPathOf = (dir: string) => join(dir, "content-search", "search-index.db");

  /** One service over a fresh temp directory, with a scripted worker port and captured health reports. */
  const withService = async (
    options: {
      script?: (job: { readonly kind: string }, postIndex: number, portIndex: number) => unknown;
      posts?: string[];
      reports?: { readonly kind: string; readonly [key: string]: unknown }[];
      ports?: number[];
      deadline?: { run<T>(operation: () => Promise<T>): Promise<T> };
      terminateFailure?: boolean;
      seed?: (dir: string) => void;
    },
    run: (service: SlateSearchIndexService, dir: string) => Promise<void>,
  ) => {
    const dir = mkdtempSync(join(tmpdir(), "slate-search-test-"));
    const posts = options.posts ?? [];
    const reports = options.reports ?? [];
    const ports = options.ports ?? [];
    try {
      options.seed?.(dir);
      const service = new SlateSearchIndexService({
        indexDbPath: indexPathOf(dir),
        agentsRootDir: join(dir, "agents"),
        disposeDeadline: options.deadline ?? { async run<T>(operation: () => Promise<T>) { return await operation(); } },
        report: (health) => { reports.push(health); },
        createJobPort: () => {
          const portIndex = ports.length;
          ports.push(portIndex);
          let postIndex = 0;
          return {
            async post(job: { readonly kind: string }) {
              const current = postIndex++;
              posts.push(job.kind);
              return (options.script?.(job, current, portIndex) ?? ok()) as never;
            },
            async terminate() {
              if (options.terminateFailure === true) throw new Error("terminate failed");
            },
          };
        },
      });
      await run(service, dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  /** Lets every job a turn's work queued run, including the ones a failure queues behind itself. */
  const drain = async (service: SlateSearchIndexService) => {
    for (let attempt = 0; attempt < 40; attempt += 1) await service.whenIdle();
  };

  it("bounds its rebuilds, respawns and reconciles, and gives disposal a deadline", () => {
    assert.equal(MAX_INDEX_REBUILDS, 3);
    assert.equal(MAX_WORKER_RESPAWNS, 3);
    assert.equal(MAX_FAILED_JOB_RECONCILES, 3);
    assert.equal(SEARCH_INDEX_DISPOSE_TIMEOUT_MS, 2_000);
    assert.equal(defaultWorkerEntryPath().endsWith("/extensions/content-search/search-index-worker.cjs"), true);
  });

  it("reconciles once on start and is ready only after the reconcile", async () => {
    const posts: string[] = [];
    await withService({ posts }, async (service) => {
      assert.equal(service.searchMessages("hello", 5), null);
      assert.equal(service.searchMedia("hello", 5), null);
      service.start();
      assert.equal(service.isSearchReady, false);
      await drain(service);
      assert.equal(service.isSearchReady, true);
      assert.deepEqual(posts, ["reconcile"]);
      assert.deepEqual(service.searchMessages("hello", 5), []);
      assert.deepEqual(service.searchMedia("hello", 5), []);
    });
  });

  it("turns every mutation into the job the writer asked for", async () => {
    const posts: string[] = [];
    await withService({ posts }, async (service) => {
      service.start();
      await drain(service);
      service.applyMutation({ kind: "entries-upserted", agentId: "agent-1", entries: [] });
      service.applyMutation({ kind: "entries-upserted", agentId: "agent-1", entries: [{ id: "entry-1", kind: "message", content: "hello" }] });
      service.applyMutation({ kind: "entry-deleted", agentId: "agent-1", entryId: "entry-1" });
      service.applyMutation({ kind: "conversation-cleared", agentId: "agent-1" });
      service.applyMutation({ kind: "agent-removed", agentId: "agent-2" });
      service.applyMutation({ kind: "agent-needs-reindex", agentId: "agent-3" });
      await drain(service);
      assert.deepEqual(posts, ["reconcile", "upsert-entries", "delete-entry", "clear-agent", "clear-agent", "reindex-agents"]);
      assert.equal(service.isSearchReady, true);
    });
  });

  it("counts a reindex as pending until its job has run", async () => {
    await withService({}, async (service) => {
      service.start();
      await drain(service);
      service.applyMutation({ kind: "agent-needs-reindex", agentId: "agent-3" });
      assert.equal(service.isSearchReady, false);
      await drain(service);
      assert.equal(service.isSearchReady, true);
    });
  });

  it("queues nothing for mutations made before the index is open", async () => {
    const posts: string[] = [];
    await withService({ posts }, async (service) => {
      service.applyMutation({ kind: "entries-upserted", agentId: "agent-1", entries: [{ id: "entry-1", kind: "message" }] });
      service.applyMutation({ kind: "agent-needs-reindex", agentId: "agent-3" });
      service.applyMutation({ kind: "something-else", agentId: "agent-1" } as never);
      await drain(service);
      service.start();
      await drain(service);
      assert.deepEqual(posts, ["reconcile"]);
    });
  });

  it("replaces a worker that went away, and stops once respawns run out", async () => {
    const reports: { readonly kind: string; readonly [key: string]: unknown }[] = [];
    const ports: number[] = [];
    await withService({ reports, ports, script: (job, post, port) => (port === 0 && job.kind === "reconcile" ? workerUnavailable("worker gone") : ok()) }, async (service) => {
      service.start();
      await drain(service);
      assert.deepEqual(reports, [{ kind: "worker_respawn", count: 1 }]);
      assert.equal(service.isSearchReady, true);
    });
    const stoppedReports: { readonly kind: string; readonly [key: string]: unknown }[] = [];
    const stoppedPorts: number[] = [];
    await withService({ reports: stoppedReports, ports: stoppedPorts, script: () => workerUnavailable("worker gone") }, async (service) => {
      service.start();
      await drain(service);
      assert.equal(service.isSearchReady, false);
      assert.equal(service.searchMessages("hello", 5), null);
      assert.deepEqual(stoppedReports.map((report) => [report.kind, report.stage ?? null]), [
        ["worker_respawn", null],
        ["worker_respawn", null],
        ["worker_respawn", null],
        ["unavailable", "worker-respawn"],
      ]);
      assert.equal(stoppedPorts.length, 4);
      service.start();
      await drain(service);
      assert.equal(stoppedPorts.length, 4);
    });
  });

  it("reconciles after a failed job, and stops once reconciles run out", async () => {
    const reports: { readonly kind: string; readonly [key: string]: unknown }[] = [];
    await withService({ reports, script: (job) => (job.kind === "upsert-entries" ? failed("upsert broke") : ok()) }, async (service) => {
      service.start();
      await drain(service);
      service.applyMutation({ kind: "entries-upserted", agentId: "agent-1", entries: [{ id: "entry-1", kind: "message" }] });
      await drain(service);
      assert.deepEqual(reports, [{ kind: "job_reconcile", stage: "upsert-entries", count: 1 }]);
      assert.equal(service.isSearchReady, true);
    });
    const stoppedReports: { readonly kind: string; readonly [key: string]: unknown }[] = [];
    await withService({ reports: stoppedReports, script: (job) => (job.kind === "reconcile" ? failed("reconcile broke") : ok()) }, async (service) => {
      service.start();
      await drain(service);
      assert.deepEqual(stoppedReports.map((report) => [report.kind, report.count ?? report.stage ?? null]), [
        ["job_reconcile", 1],
        ["job_reconcile", 2],
        ["job_reconcile", 3],
        ["unavailable", "job-reconcile"],
      ]);
      service.start();
      await drain(service);
      assert.equal(stoppedReports.length, 4);
    });
  });

  it("retries a failed reindex, and stops once retries run out", async () => {
    const reports: { readonly kind: string; readonly [key: string]: unknown }[] = [];
    await withService({ reports, script: (job) => (job.kind === "reindex-agents" ? failed("reindex broke") : ok()) }, async (service) => {
      service.start();
      await drain(service);
      service.applyMutation({ kind: "agent-needs-reindex", agentId: "agent-3" });
      await drain(service);
      assert.deepEqual(reports.map((report) => [report.kind, report.count ?? report.stage ?? null]), [
        ["job_retry", 1],
        ["job_retry", 2],
        ["job_retry", 3],
        ["unavailable", "job-reindex-agents"],
      ]);
      assert.equal(service.isSearchReady, false);
    });
  });

  it("rebuilds a corrupt index, and stops once rebuilds run out", async () => {
    const reports: { readonly kind: string; readonly [key: string]: unknown }[] = [];
    const ports: number[] = [];
    await withService({ reports, ports, script: (job, post, port) => (port === 0 && job.kind === "reconcile" ? corrupt("index corrupt") : ok()) }, async (service) => {
      service.start();
      await drain(service);
      assert.deepEqual(reports, [{ kind: "corrupt_rebuild", stage: "job-reconcile", count: 1 }]);
      assert.equal(service.isSearchReady, true);
      assert.equal(ports.length, 2);
    });
    const stoppedReports: { readonly kind: string; readonly [key: string]: unknown }[] = [];
    const stoppedPorts: number[] = [];
    await withService({ reports: stoppedReports, ports: stoppedPorts, script: (job) => (job.kind === "reconcile" ? corrupt("index corrupt") : ok()) }, async (service) => {
      service.start();
      await drain(service);
      assert.deepEqual(stoppedReports.map((report) => [report.kind, report.count ?? report.stage ?? null]), [
        ["corrupt_rebuild", 1],
        ["corrupt_rebuild", 2],
        ["corrupt_rebuild", 3],
        ["unavailable", "job-reconcile"],
      ]);
      const portCount = stoppedPorts.length;
      service.start();
      await drain(service);
      assert.equal(stoppedPorts.length, portCount);
    });
  });

  it("replaces an index file that cannot be opened or is another schema's", async () => {
    await withService({ seed: (dir) => { mkdirSync(join(dir, "content-search"), { recursive: true }); writeFileSync(indexPathOf(dir), Buffer.from("not a database")); } }, async (service) => {
      service.start();
      await drain(service);
      assert.equal(service.isSearchReady, true);
    });
    await withService({ seed: (dir) => {
      mkdirSync(join(dir, "content-search"), { recursive: true });
      const database = openSearchIndexDb(indexPathOf(dir));
      ensureSearchIndexSchema(database);
      database.prepare("INSERT INTO messages (agent_id, entry_id, role, timestamp_ms, body) VALUES (?, ?, ?, ?, ?)").run("agent-1", "entry-1", "user", 1_000, "an old message");
      database.close();
    } }, async (service) => {
      service.start();
      await drain(service);
      assert.deepEqual(service.searchMessages("old", 5), []);
      assert.equal(service.isSearchReady, true);
    });
  });

  it("searches an index that is already reconciled", async () => {
    await withService({ seed: (dir) => {
      mkdirSync(join(dir, "content-search"), { recursive: true });
      const database = openSearchIndexDb(indexPathOf(dir));
      ensureSearchIndexSchema(database);
      stampSearchIndexSchemaVersion(database);
      writeReconcileDone(database);
      database.prepare("INSERT INTO messages (agent_id, entry_id, role, timestamp_ms, body) VALUES (?, ?, ?, ?, ?)").run("agent-1", "entry-1", "user", 1_000, "a needle in the haystack");
      database.prepare("INSERT INTO media (agent_id, entry_id, file_name, ext, mime, kind, timestamp_ms, width, height) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("agent-1", "entry-2", "photo.png", ".png", "image/png", "image", 2_000, 10, 20);
      database.close();
    } }, async (service) => {
      service.start();
      assert.equal(service.isSearchReady, true);
      const messages = service.searchMessages("needle", 5) ?? [];
      assert.equal(messages.length, 1);
      assert.equal(messages[0]?.entryId, "entry-1");
      assert.equal(messages[0]?.role, "user");
      const media = service.searchMedia("photo", 5) ?? [];
      assert.equal(media.length, 1);
      assert.equal(media[0]?.fileName, "photo.png");
      await drain(service);
    });
  });

  it("drains, terminates and closes on dispose, and reports a missed deadline or a failed terminate", async () => {
    const reports: { readonly kind: string; readonly [key: string]: unknown }[] = [];
    const posts: string[] = [];
    await withService({ reports, posts }, async (service) => {
      service.start();
      await drain(service);
      await service.dispose();
      assert.equal(service.isSearchReady, false);
      assert.equal(service.searchMessages("hello", 5), null);
      service.start();
      service.applyMutation({ kind: "agent-needs-reindex", agentId: "agent-3" });
      await drain(service);
      assert.deepEqual(reports, []);
      // A disposed service stays disposed: nothing more is queued for it.
      assert.deepEqual(posts, ["reconcile"]);
    });
    await withService({ reports, deadline: { async run() { throw new Error("deadline passed"); } } }, async (service) => {
      await service.dispose();
      assert.deepEqual(reports.map((report) => report.kind), ["dispose_drain_cut"]);
    });
    const terminateReports: { readonly kind: string; readonly [key: string]: unknown }[] = [];
    await withService({ reports: terminateReports, terminateFailure: true }, async (service) => {
      service.start();
      await drain(service);
      await service.dispose();
      assert.deepEqual(terminateReports.map((report) => [report.kind, report.stage]), [["worker_terminate_failed", "dispose"]]);
    });
  });

  it("answers the jobs its worker returns, and says so when the worker dies", async () => {
    const workerDir = mkdtempSync(join(tmpdir(), "slate-search-worker-"));
    const ports: WorkerSearchIndexJobPort[] = [];
    try {
      const echoPath = join(workerDir, "echo-worker.mjs");
      writeFileSync(echoPath, [
        'import { parentPort } from "node:worker_threads";',
        'parentPort.on("message", (message) => {',
        '  if (message.job.kind === "clear-agent") return parentPort.postMessage({ requestId: message.requestId, ok: false, message: "corrupt answer", isIndexCorrupt: true });',
        '  if (message.job.kind === "delete-entry") return parentPort.postMessage({ requestId: message.requestId, ok: false });',
        '  return parentPort.postMessage({ requestId: message.requestId, ok: true });',
        "});",
      ].join("\n"));
      const port = new WorkerSearchIndexJobPort(echoPath, { indexDbPath: join(workerDir, "index.db"), agentsRootDir: join(workerDir, "agents") });
      ports.push(port);
      assert.deepEqual(await port.post({ kind: "reconcile" }), { ok: true });
      const corruptAnswer = await port.post({ kind: "clear-agent", agentId: "agent-1" });
      assert.deepEqual([corruptAnswer.ok, (corruptAnswer as { isIndexCorrupt?: boolean }).isIndexCorrupt, (corruptAnswer as { message?: string }).message], [false, true, "corrupt answer"]);
      const defaultAnswer = await port.post({ kind: "delete-entry", agentId: "agent-1", entryId: "entry-1" });
      assert.equal((defaultAnswer as { message?: string }).message, "search index job failed");
      await port.terminate();
      const afterTerminate = await port.post({ kind: "reconcile" });
      assert.deepEqual([(afterTerminate as { isWorkerUnavailable?: boolean }).isWorkerUnavailable, (afterTerminate as { message?: string }).message], [true, "search-index worker is no longer running"]);
      const exitPath = join(workerDir, "exit-worker.mjs");
      writeFileSync(exitPath, ['import { parentPort } from "node:worker_threads";', 'parentPort.once("message", () => { process.exit(4); });'].join("\n"));
      const exiting = new WorkerSearchIndexJobPort(exitPath, { indexDbPath: join(workerDir, "index.db"), agentsRootDir: join(workerDir, "agents") });
      ports.push(exiting);
      const died = await exiting.post({ kind: "reconcile" });
      assert.deepEqual([died.ok, (died as { message?: string }).message, (died as { isWorkerUnavailable?: boolean }).isWorkerUnavailable], [false, "search-index worker exited (4)", true]);
    } finally {
      // A failed assertion must not leave a worker thread keeping the process alive.
      for (const port of ports) {
        await port.terminate().catch(() => {});
      }
      rmSync(workerDir, { recursive: true, force: true });
    }
  });
});
