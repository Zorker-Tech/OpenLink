import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  loadInitialTranscriptResiliently,
  type InitialTranscriptLoadOptions,
  type InitialTranscriptLoader,
} from "../../source/host/host-initial-transcript-load.ts";

function loader(ensureLoaded: InitialTranscriptLoader<{ id: number }>['ensureLoaded']): InitialTranscriptLoader<{ id: number }> {
  return { ensureLoaded };
}

function captureLogs() {
  const entries: Array<{ message: string; error?: unknown }> = [];
  const options: InitialTranscriptLoadOptions = {
    logError(message, error) {
      entries.push({ message, ...(error === undefined ? {} : { error }) });
    },
  };
  return { entries, options };
}

describe("initial transcript startup contract", () => {
  it("returns the loaded entry count without logging", async () => {
    let calls = 0;
    const logs = captureLogs();
    const count = await loadInitialTranscriptResiliently(loader(async () => {
      calls += 1;
      return [{ id: 1 }, { id: 2 }, { id: 3 }];
    }), logs.options);

    assert.equal(count, 3);
    assert.equal(calls, 1);
    assert.deepEqual(logs.entries, []);
  });

  it("retries a transient database lock and returns the recovered transcript size", async () => {
    let calls = 0;
    const logs = captureLogs();
    const count = await loadInitialTranscriptResiliently(loader(async () => {
      calls += 1;
      if (calls === 1) throw new Error("database is locked");
      return [{ id: 1 }, { id: 2 }];
    }), logs.options);

    assert.equal(calls, 2);
    assert.equal(count, 2);
    assert.deepEqual(logs.entries, []);
  });

  it("keeps startup alive after retry exhaustion and reports the lock failure", async () => {
    let calls = 0;
    let classifierCalls = 0;
    const failure = new Error("database is locked");
    const logs = captureLogs();
    const count = await loadInitialTranscriptResiliently(loader(async () => {
      calls += 1;
      throw failure;
    }), {
      ...logs.options,
      isAgentLimitError() {
        classifierCalls += 1;
        return false;
      },
    });

    assert.equal(calls, 5);
    assert.equal(classifierCalls, 0);
    assert.equal(count, 0);
    assert.equal(logs.entries.length, 1);
    assert.match(logs.entries[0]!.message, /transcript/i);
    assert.equal(logs.entries[0]!.error, failure);
  });

  it("starts with an empty transcript at the account limit without passing the error to the log", async () => {
    let calls = 0;
    const failure = new Error("account is full");
    const classified: unknown[] = [];
    const logs = captureLogs();
    const count = await loadInitialTranscriptResiliently(loader(async () => {
      calls += 1;
      throw failure;
    }), {
      ...logs.options,
      isAgentLimitError(error) {
        classified.push(error);
        return error === failure;
      },
    });

    assert.equal(calls, 1);
    assert.deepEqual(classified, [failure]);
    assert.equal(count, 0);
    assert.equal(logs.entries.length, 1);
    assert.match(logs.entries[0]!.message, /cap|limit/i);
    assert.equal("error" in logs.entries[0]!, false);
  });

  it("preserves all other startup failures without logging or retrying", async () => {
    let calls = 0;
    const failure = new Error("transcript data is malformed");
    const logs = captureLogs();
    await assert.rejects(
      loadInitialTranscriptResiliently(loader(async () => {
        calls += 1;
        throw failure;
      }), logs.options),
      (error) => error === failure,
    );
    assert.equal(calls, 1);
    assert.deepEqual(logs.entries, []);
  });
});
