import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";

interface VacuumReply {
  readonly ok: boolean;
  readonly message?: string;
}

function requestVacuum(worker: Worker, job: { srcPath: string; destPath: string; busyTimeoutMs: number }): Promise<VacuumReply> {
  return new Promise((resolve, reject) => {
    const onMessage = (reply: VacuumReply) => {
      worker.off("error", onError);
      resolve(reply);
    };
    const onError = (error: Error) => {
      worker.off("message", onMessage);
      reject(error);
    };
    worker.once("message", onMessage);
    worker.once("error", onError);
    worker.postMessage(job);
  });
}

test("the worker returns a readable snapshot and reports failed copies without exiting", async () => {
  const directory = await mkdtemp(join(tmpdir(), "box-store-vacuum-worker-"));
  const sourcePath = join(directory, "source.db");
  const outputPath = join(directory, "snapshot.db");
  const afterFailurePath = join(directory, "snapshot-after-error.db");
  const database = new DatabaseSync(sourcePath);
  database.exec("CREATE TABLE item (value TEXT NOT NULL); INSERT INTO item VALUES ('preserved');");
  database.close();

  const worker = new Worker(
    new URL("../../source/host/boxes/box-store-sync/box-store-vacuum-worker.ts", import.meta.url),
    { execArgv: ["--experimental-transform-types"] },
  );
  try {
    assert.deepEqual(await requestVacuum(worker, { srcPath: sourcePath, destPath: outputPath, busyTimeoutMs: 250 }), { ok: true });

    const snapshot = new DatabaseSync(outputPath, { readOnly: true });
    assert.equal(snapshot.prepare("SELECT value FROM item").get()?.value, "preserved");
    snapshot.close();

    const failed = await requestVacuum(worker, {
      srcPath: join(directory, "missing.db"),
      destPath: join(directory, "failed.db"),
      busyTimeoutMs: 250,
    });
    assert.equal(failed.ok, false);
    assert.match(failed.message ?? "", /unable to open|no such file/i);

    assert.deepEqual(await requestVacuum(worker, { srcPath: sourcePath, destPath: afterFailurePath, busyTimeoutMs: 250 }), { ok: true });
  } finally {
    await worker.terminate();
    await rm(directory, { recursive: true, force: true });
  }
});
