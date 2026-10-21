/**
 * The host's runtime pieces, sixth group: the transcript a host keeps, the recovery scan, the initial load,
 * the replica writer, what a message may say, and the telemetry around them.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ConversationRecoveryScanError } from "../../source/host/extensions/session/session-recovery.ts";
import { appendEntry, getTranscript, setTranscript, updateEntry } from "../../source/host/transcript/transcript-store.ts";
import { EXPERIMENTS_DIAGNOSTIC_EVENT, experimentsDiagnosticTelemetry } from "../../source/host/telemetry/experiments-diagnostic-telemetry.ts";
import { MEMORY_SYNTHESIS_EVENT, memorySynthesisTelemetry } from "../../source/host/telemetry/memory-synthesis-telemetry.ts";
import { SLATE_BOX_BOOT_ID_ENV, SLATE_BOX_BOOT_STAGES, slateErrorDetail } from "../../source/host/ports/telemetry.ts";
import { HostReplicaWriter } from "../../source/host/transcript/replica-writer.ts";
import { SEND_MESSAGE_TYPES, SEND_MESSAGE_TYPE_DESCRIPTION } from "../../source/host/runner/tools/send-message-schema.ts";
import { SHELL_REWATCH_MAX_WAIT_MS, SHELL_REWATCH_POLL_DEFAULT_MS } from "../../source/host/runner/background-work.ts";
import { ensureProfileFile } from "../../source/host/extensions/session/session-recovery.ts";

describe("the transcript a host keeps", () => {
  it("appends, updates and replaces, and keeps its own copy of what it was given", () => {
    setTranscript([{ id: "e1", kind: "message" }]);
    const given = [{ id: "e2", kind: "notice" }];
    appendEntry(given[0] as never);
    given.push({ id: "e3", kind: "notice" } as never);
    assert.deepEqual(getTranscript().map((entry) => entry.id), ["e1", "e2"]);
    updateEntry("e1", (entry) => ({ ...entry, kind: "edited" }));
    assert.equal(getTranscript()[0]?.kind, "edited");
    updateEntry("missing", (entry) => entry);
    setTranscript([]);
    assert.deepEqual(getTranscript(), []);
  });
});

describe("recovering a conversation", () => {
  it("says what a scan could not do", () => {
    const error = new ConversationRecoveryScanError("no records");
    assert.equal(error.name, "ConversationRecoveryScanError");
    assert.equal(error.message, "conversation recovery scan failed: no records");
    assert.equal(typeof ensureProfileFile, "function");
  });
});

describe("the order a surface is replicated in", () => {
  it("stamps every write with the writer's epoch and the sequence it is at", () => {
    const epoch = "123e4567-e89b-42d3-a456-426614174000";
    const writer = new HostReplicaWriter(epoch);
    assert.equal(writer.processEpoch, epoch);
    assert.deepEqual(writer.nextStamp("members"), { replicaKey: "members", epoch, sequence: 1 });
    assert.deepEqual(writer.nextStamp("members"), { replicaKey: "members", epoch, sequence: 2 });
    const snapshot = writer.viewOf("members", "full", { cases: 1 });
    assert.equal(snapshot.epoch, epoch);
    assert.equal(snapshot.coverage, "full");
    assert.equal(typeof snapshot.throughSequence, "number");
    assert.equal(snapshot.replicaKey, "members");
    assert.deepEqual(snapshot.value, { cases: 1 });
  });
});

describe("what a model may send as a message", () => {
  it("names the kinds of message, with the cloud-agent kind named after us", () => {
    assert.deepEqual([...SEND_MESSAGE_TYPES], ["text", "attachment", "widget", "slate-agent", "secret-request"]);
    assert.match(SEND_MESSAGE_TYPE_DESCRIPTION, /slate-agent to reference a Slate cloud agent/);
    assert.equal(SEND_MESSAGE_TYPE_DESCRIPTION.includes("Cursor"), false);
    assert.equal(SEND_MESSAGE_TYPE_DESCRIPTION.includes("cursor"), false);
  });
});

describe("the work a turn leaves running", () => {
  it("bounds how long a shell is watched and how often it is looked at", () => {
    assert.equal(SHELL_REWATCH_POLL_DEFAULT_MS > 0, true);
    assert.equal(SHELL_REWATCH_MAX_WAIT_MS >= SHELL_REWATCH_POLL_DEFAULT_MS, true);
  });
});

describe("the telemetry a host reports", () => {
  it("describes an error, and names the stages a box boots through", () => {
    assert.deepEqual(slateErrorDetail(new Error("boom")).message, "boom");
    assert.equal(slateErrorDetail("plain").message, "plain");
    assert.deepEqual([...SLATE_BOX_BOOT_STAGES], ["entrypoint_started", "daemon_listening", "desktop_up", "ready"]);
    assert.equal(SLATE_BOX_BOOT_ID_ENV, "SLATE_BOX_BOOT_ID");
  });

  it("reports the experiments client under our own event name and level", () => {
    assert.equal(EXPERIMENTS_DIAGNOSTIC_EVENT, "slate.experiments.diagnostic");
    assert.equal(experimentsDiagnosticTelemetry({ kind: "exposure_flush_failed" }).level, "info");
    assert.equal(experimentsDiagnosticTelemetry({ kind: "bootstrap_config_unparseable" }).level, "warn");
    assert.equal(experimentsDiagnosticTelemetry({ kind: "something_else" }).level, "error");
  });

  it("reports memory synthesis with the outcome it ended at", () => {
    assert.equal(MEMORY_SYNTHESIS_EVENT, "slate.memory.synthesis");
    assert.deepEqual(memorySynthesisTelemetry({ outcome: "skipped_gate" }), {
      level: "info",
      event: "slate.memory.synthesis",
      metadata: { outcome: "skipped_gate" },
    });
  });
});
