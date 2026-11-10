import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createContext } from "../../source/packages/context/context.ts";
import { BoxEnvironmentSyncUnsupportedError } from "../../source/host/ports/box.ts";
import {
  BOX_SECRETS_FILENAME,
  BoxSecretsApplier,
  BoxSecretsValidationError,
  getBoxSecretsStorePath,
  SECRETS_APPLY_WAIT_MS,
  SECRETS_RETRY_INITIAL_MS,
  SECRETS_RETRY_MAX_MS,
} from "../../source/host/extensions/secrets/secrets-service.ts";
import type { DeadlinePolicy, RetryPolicy } from "../../source/host/extensions/scheduling.ts";
import { SLATE_BOX_SECRET_NAMES_ENV } from "../../source/shared/box-secret-policy.ts";
import { SLATE_DATA_ROOT_ENV } from "../../source/host/host-paths.ts";

function retryPolicy(schedule: (attempt: number, signal?: AbortSignal) => { elapsed: Promise<void>; dispose(): void } = () => ({ elapsed: Promise.resolve(), dispose() {} })): RetryPolicy {
  return { name: "secret-retry", schedule, runWithRetry: async () => { throw new Error("not used by this service"); } };
}

const defaultDeadlineRun: DeadlinePolicy["run"] = async <T>(
  work: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
) => work(signal ?? new AbortController().signal);

function deadlinePolicy(run: DeadlinePolicy["run"] = defaultDeadlineRun): DeadlinePolicy {
  return { name: "secret-deadline", run };
}

async function withStore(run: (storePath: string, rootDir: string) => Promise<void>): Promise<void> {
  const rootDir = mkdtempSync(join(tmpdir(), "slate-secrets-service-contract-"));
  try {
    await run(join(rootDir, BOX_SECRETS_FILENAME), rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function applier(args: {
  readonly storePath: string;
  readonly applyToBox?: (ctx: ReturnType<typeof createContext>, update: { env: Record<string, string>; replace: true }) => Promise<void>;
  readonly retryPolicy?: RetryPolicy;
  readonly applyDeadline?: DeadlinePolicy;
  readonly log?: (message: string) => void;
  readonly now?: () => number;
}) {
  const applications: Array<{ ctx: unknown; env: Record<string, string>; replace: true }> = [];
  const messages: string[] = [];
  const service = new BoxSecretsApplier({
    storePath: args.storePath,
    applyToBox: async (ctx, update) => {
      applications.push({ ctx, env: update.env, replace: update.replace });
      await args.applyToBox?.(ctx as ReturnType<typeof createContext>, update);
    },
    retryPolicy: args.retryPolicy ?? retryPolicy(),
    applyDeadline: args.applyDeadline ?? deadlinePolicy(),
    log: args.log ?? ((message) => messages.push(message)),
    now: args.now ?? (() => 500),
  });
  return { service, applications, messages };
}

test("secret store names and retry/deadline constants are stable", () => {
  assert.deepEqual([BOX_SECRETS_FILENAME, SECRETS_APPLY_WAIT_MS, SECRETS_RETRY_INITIAL_MS, SECRETS_RETRY_MAX_MS], ["box-secrets.json", 5_000, 1_000, 30_000]);
  const refusal = new BoxSecretsValidationError("invalid");
  assert.equal(refusal instanceof BoxSecretsValidationError, true);
  assert.deepEqual([refusal.name, refusal.message], ["Error", "invalid"]);
});

test("the default secret store path follows the Slate data-root override", async () => {
  await withStore(async (_path, rootDir) => {
    const previous = process.env[SLATE_DATA_ROOT_ENV];
    process.env[SLATE_DATA_ROOT_ENV] = rootDir;
    try {
      assert.equal(getBoxSecretsStorePath(), join(rootDir, BOX_SECRETS_FILENAME));
    } finally {
      if (previous === undefined) delete process.env[SLATE_DATA_ROOT_ENV];
      else process.env[SLATE_DATA_ROOT_ENV] = previous;
    }
  });
});

test("a new applier starts unapplied with no secret names", async () => {
  await withStore(async (storePath) => {
    const { service, applications } = applier({ storePath });
    assert.deepEqual(service.getStatus(), { keys: [], isApplied: false, lastAppliedAtMs: null });
    assert.equal(applications.length, 0);
  });
});

test("setSecrets validates before persisting or applying", async () => {
  await withStore(async (storePath) => {
    const { service, applications } = applier({ storePath });
    await assert.rejects(() => service.setSecrets(createContext(), { PATH: "override" }), (error: unknown) => error instanceof BoxSecretsValidationError && error.message === "PATH is reserved by the box runtime");
    assert.equal(applications.length, 0);
    assert.equal(existsSync(storePath), false);
  });
});

test("setSecrets persists first, copies its input and applies a sorted redaction environment", async () => {
  await withStore(async (storePath) => {
    const ctx = createContext().withName("set-secrets");
    let storedAtApply: unknown;
    const secrets = { B: "two", A: "one" };
    const { service, applications } = applier({
      storePath,
      applyToBox: async () => { storedAtApply = existsSync(storePath) ? JSON.parse(readFileSync(storePath, "utf8")) : null; },
    });
    const pending = service.setSecrets(ctx, secrets);
    secrets.A = "changed after call";
    const result = await pending;
    assert.deepEqual(storedAtApply, { version: 1, secrets: { B: "two", A: "one" } });
    assert.deepEqual(applications[0], {
      ctx,
      env: { A: "one", B: "two", [SLATE_BOX_SECRET_NAMES_ENV]: "A,B" },
      replace: true,
    });
    assert.deepEqual(result, { keys: ["A", "B"], isApplied: true, lastAppliedAtMs: 500 });
  });
});

test("secret persistence is private and leaves no staging file behind", async () => {
  await withStore(async (storePath, rootDir) => {
    const { service } = applier({ storePath });
    await service.setSecrets(createContext(), { A: "secret" });
    assert.equal(statSync(storePath).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(rootDir), [BOX_SECRETS_FILENAME]);
  });
});

test("successful saves advance one generation and timestamp the applied snapshot", async () => {
  await withStore(async (storePath) => {
    let now = 1_000;
    const { service, applications } = applier({ storePath, now: () => now });
    const first = await service.setSecrets(createContext(), { A: "1" });
    assert.deepEqual(first, { keys: ["A"], isApplied: true, lastAppliedAtMs: 1_000 });
    now = 2_000;
    const second = await service.setSecrets(createContext(), { B: "2" });
    assert.deepEqual(second, { keys: ["B"], isApplied: true, lastAppliedAtMs: 2_000 });
    assert.equal(applications.length, 2);
  });
});

test("persisted version-one values apply at startup once and are logged", async () => {
  await withStore(async (storePath) => {
    writeFileSync(storePath, JSON.stringify({ version: 1, secrets: { TOKEN: "one", API_KEY: "two" } }));
    const { service, applications, messages } = applier({ storePath });
    await service.applyPersisted(createContext());
    await service.applyPersisted(createContext());
    assert.equal(applications.length, 1);
    assert.deepEqual(service.getStatus(), { keys: ["API_KEY", "TOKEN"], isApplied: true, lastAppliedAtMs: 500 });
    assert.deepEqual(messages, ["applying 2 persisted box secret(s) at startup"]);
  });
});

test("missing, malformed, and unsupported persisted stores are ignored", async () => {
  await withStore(async (storePath) => {
    const { service, applications } = applier({ storePath });
    for (const persisted of ["not-json", JSON.stringify({ version: 2, secrets: { A: "1" } }), JSON.stringify({ version: 1, secrets: { A: 1 } }), JSON.stringify({ version: 1, secrets: [] })]) {
      writeFileSync(storePath, persisted);
      await service.applyPersisted(createContext());
    }
    assert.equal(applications.length, 0);
    assert.deepEqual(service.getStatus(), { keys: [], isApplied: false, lastAppliedAtMs: null });
  });
});

test("an explicit set takes precedence over persisted startup values", async () => {
  await withStore(async (storePath) => {
    writeFileSync(storePath, JSON.stringify({ version: 1, secrets: { OLD: "old" } }));
    const { service, applications, messages } = applier({ storePath });
    await service.setSecrets(createContext(), { NEW: "new" });
    await service.applyPersisted(createContext());
    assert.deepEqual(applications.map(({ env }) => Object.keys(env)), [["NEW", SLATE_BOX_SECRET_NAMES_ENV]]);
    assert.deepEqual(messages, []);
  });
});

test("apply failures schedule increasing attempts and retry until one succeeds", async () => {
  await withStore(async (storePath) => {
    const scheduled: number[] = [];
    let disposed = 0;
    let applications = 0;
    const retry = retryPolicy((attempt) => {
      scheduled.push(attempt);
      return { elapsed: Promise.resolve(), dispose() { disposed += 1; } };
    });
    const { service, messages } = applier({
      storePath,
      retryPolicy: retry,
      applyToBox: async () => { applications += 1; if (applications < 3) throw new Error("box busy"); },
    });
    const status = await service.setSecrets(createContext(), { A: "1" });
    assert.deepEqual(scheduled, [1, 2]);
    assert.equal(disposed, 2);
    assert.equal(status.isApplied, true);
    assert.deepEqual(messages, ["box secrets: apply failed (attempt 1); retrying", "box secrets: apply failed (attempt 2); retrying"]);
  });
});

test("unsupported environment sync stops retries and leaves the generation unapplied", async () => {
  await withStore(async (storePath) => {
    let applications = 0;
    const scheduled: number[] = [];
    let stopService: (() => void) | undefined;
    const { service, messages } = applier({
      storePath,
      retryPolicy: retryPolicy((attempt) => {
        scheduled.push(attempt);
        stopService?.();
        return { elapsed: Promise.resolve(), dispose() {} };
      }),
      applyToBox: async () => { applications += 1; throw new BoxEnvironmentSyncUnsupportedError(); },
    });
    stopService = () => service.stop();
    const status = await service.setSecrets(createContext(), { A: "1" });
    assert.equal(applications, 1);
    assert.deepEqual(scheduled, []);
    assert.equal(status.isApplied, false);
    assert.deepEqual(messages, ["box secrets: this box has no environment sync; giving up"]);
  });
});

test("a newer generation is applied after an older in-flight update finishes", async () => {
  await withStore(async (storePath) => {
    let releaseFirst!: () => void;
    const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const startedFirst = Promise.withResolvers<void>();
    const updates: Array<Record<string, string>> = [];
    const { service } = applier({
      storePath,
      applyToBox: async (_ctx, update) => {
        updates.push(update.env);
        if (updates.length === 1) { startedFirst.resolve(); await firstReleased; }
      },
    });
    const first = service.setSecrets(createContext(), { FIRST: "one" });
    await startedFirst.promise;
    const second = service.setSecrets(createContext(), { SECOND: "two" });
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(updates.map((env) => Object.keys(env)), [
      ["FIRST", SLATE_BOX_SECRET_NAMES_ENV],
      ["SECOND", SLATE_BOX_SECRET_NAMES_ENV],
    ]);
    assert.deepEqual(service.getStatus(), { keys: ["SECOND"], isApplied: true, lastAppliedAtMs: 500 });
  });
});

test("stop aborts retry waits and wakes callers with the unapplied status", async () => {
  await withStore(async (storePath) => {
    let retryStarted!: () => void;
    const started = new Promise<void>((resolve) => { retryStarted = resolve; });
    let retryAborted = false;
    const retry = retryPolicy((_attempt, signal) => ({
      elapsed: new Promise<void>((_resolve, reject) => {
        retryStarted();
        signal?.addEventListener("abort", () => { retryAborted = true; reject(signal.reason); }, { once: true });
      }),
      dispose() {},
    }));
    const { service } = applier({ storePath, retryPolicy: retry, applyToBox: async () => { throw new Error("offline"); } });
    const pending = service.setSecrets(createContext(), { A: "1" });
    await started;
    service.stop();
    const settled = await Promise.race([
      pending.then((status) => status),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 250)),
    ]);
    assert.notEqual(settled, null, "stop resolves callers waiting for the current generation");
    const status = settled!;
    assert.equal(status.isApplied, false);
    assert.equal(retryAborted, true);
  });
});

test("an apply deadline reports that completion was not confirmed", async () => {
  await withStore(async (storePath) => {
    const messages: string[] = [];
    const deadline = deadlinePolicy(async () => { throw new Error("too slow"); });
    const { service } = applier({ storePath, applyDeadline: deadline, log: (message) => messages.push(message), applyToBox: async () => new Promise(() => {}) });
    const status = await service.setSecrets(createContext(), { A: "1" });
    assert.equal(status.isApplied, false);
    assert.equal(messages[0]?.startsWith("box secrets: apply wait ended unconfirmed"), true);
    service.stop();
  });
});
