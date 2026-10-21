import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";

import { captureSandboxDenies, registerSandboxMetadata } from "../../source/packages/shell-exec/sandbox/macos/seatbelt.ts";

/** A child process stands in for the spawned one: only its identity matters here. */
const child = () => new EventEmitter() as never;

/** A log query that answers with one ndjson record per message, as `log show --style ndjson` would. */
const logSaying = (...messages: string[]) => async () => messages.map((eventMessage) => JSON.stringify({ eventMessage, timestamp: "t" })).join("\n");

/** A log query that answers with these lines exactly as they are written. */
const logWriting = (...lines: string[]) => async () => lines.join("\n");

type Event = {
  readonly processName?: string;
  readonly pid?: number;
  readonly decision?: string;
  readonly decisionCode?: number;
  readonly operation?: string;
  readonly target?: string;
  readonly duplicateCount?: number;
  readonly raw?: string;
  readonly relationship?: string;
  readonly timestamp?: unknown;
};

/** Reads one log through the sandbox reader, with the process and the pids already known to be foreign. */
async function read(messages: string[], options: { pid?: number; unrelated?: number[] } = {}): Promise<Event[]> {
  const process = child();
  registerSandboxMetadata(process, { pid: options.pid ?? 4242, startTime: new Date(Date.now() - 1_000), unrelatedPids: new Set(options.unrelated ?? []) });
  return (await captureSandboxDenies(process, { runLogQuery: logSaying(...messages) })) as Event[];
}

describe("reading what a sandboxed command was refused", () => {
  it("reads a denial's process, decision, operation and target out of the line", async () => {
    const [event] = await read(["Sandbox: sudo(4242) deny(1) file-read-data /etc/shadow"]);
    assert.deepEqual(event, {
      timestamp: "t",
      processName: "sudo",
      pid: 4242,
      decision: "deny",
      decisionCode: 1,
      operation: "file-read-data",
      target: "/etc/shadow",
      duplicateCount: 1,
      raw: "Sandbox: sudo(4242) deny(1) file-read-data /etc/shadow",
      relationship: "related",
    });
  });

  it("keeps every field of a denial on one line, spaces in the target included", async () => {
    const [event] = await read(["Sandbox: node(4300) deny(2) network-outbound https://example.com/a b"]);
    assert.equal(event?.processName, "node");
    assert.equal(event?.target, "https://example.com/a b");
    assert.equal(event?.relationship, "maybe_related");
  });

  it("lowercases the decision but not the operation", async () => {
    const [event] = await read(["Sandbox: node(4242) DENY(7) signal-kill pid:1"]);
    assert.equal(event?.decision, "deny");
    assert.equal(event?.operation, "signal-kill");
  });

  it("counts a repeated denial instead of repeating it", async () => {
    const [event] = await read(["7 duplicate report for Sandbox: git(4300) deny(2) process-exec /usr/bin/ssh"]);
    assert.equal(event?.duplicateCount, 7);
    assert.equal(event?.raw, "7 duplicate report for Sandbox: git(4300) deny(2) process-exec /usr/bin/ssh");
    assert.equal(event?.target, "/usr/bin/ssh");
  });

  it("trims the padding a repeat line leaves in front of the process name", async () => {
    const [event] = await read(["4 duplicate report for Sandbox:   sudo(4242) deny(1) file-read-data /etc/shadow"]);
    assert.equal(event?.processName, "sudo");
    assert.equal(event?.duplicateCount, 4);
  });

  it("reports a repeat it cannot read the outer line of, and still carries the count", async () => {
    const [event] = await read(["9 duplicate report for Sandbox: something else entirely"]);
    assert.deepEqual(event, { timestamp: "t", duplicateCount: 9, raw: "9 duplicate report for Sandbox: something else entirely" });
  });

  it("carries a line it cannot read at all, rather than dropping it", async () => {
    const events = await read(["Sandbox: a line the kernel never writes", "Sandbox: broken(notanumber) deny(1) op target"]);
    assert.deepEqual(events.map((event) => event.raw), ["Sandbox: a line the kernel never writes", "Sandbox: broken(notanumber) deny(1) op target"]);
    assert.equal(events[0]?.relationship, undefined);
  });

  it("skips a log line that is not a record, and the ones with nothing to report", async () => {
    const process = child();
    registerSandboxMetadata(process, { pid: 4242, startTime: new Date() });
    const events = (await captureSandboxDenies(process, {
      runLogQuery: logWriting("not json at all", '{"timestamp":"no message"}', '{"eventMessage":""}', '{"eventMessage":42}', '{"eventMessage":"Sandbox: real(4242) deny(1) op target","timestamp":"t"}'),
    })) as Event[];
    assert.equal(events.length, 1);
    assert.equal(events[0]?.processName, "real");
  });
});

describe("how a denial relates to the process that was sandboxed", () => {
  it("calls the sandboxed process itself related", async () => {
    const [event] = await read(["Sandbox: sudo(4242) deny(1) op target"], { pid: 4242 });
    assert.equal(event?.relationship, "related");
  });

  it("calls a pid known to be someone else probably unrelated", async () => {
    const [event] = await read(["Sandbox: other(9999) deny(1) op target"], { pid: 4242, unrelated: [9999] });
    assert.equal(event?.relationship, "probably_unrelated");
  });

  it("leaves anything else to the caller", async () => {
    const [event] = await read(["Sandbox: stranger(5555) deny(1) op target"], { pid: 4242, unrelated: [9999] });
    assert.equal(event?.relationship, "maybe_related");
  });
});

describe("what the reader does when it cannot read", () => {
  it("reads nothing for a process it knows nothing about", async () => {
    assert.deepEqual(await captureSandboxDenies(child(), { runLogQuery: logSaying("Sandbox: a(1) deny(1) op target") }), []);
  });

  it("reports a log that cannot be queried as one event, not as a command that was never refused", async () => {
    const process = child();
    registerSandboxMetadata(process, { pid: 4242, startTime: new Date() });
    const events = (await captureSandboxDenies(process, {
      runLogQuery: async () => {
        throw new Error("log: cannot read");
      },
    })) as Event[];
    assert.deepEqual(events, [{ raw: "log: cannot read" }]);
  });

  it("reads an empty log as no denials, and keeps a record that says nothing", async () => {
    assert.deepEqual(await read([]), []);
    // A message that is only space is still a message the kernel wrote: it is carried, not dropped.
    assert.deepEqual((await read(["   "])).map((event) => event.raw), ["   "]);
  });

  it("asks the log for the window the command has been running in", async () => {
    const process = child();
    registerSandboxMetadata(process, { pid: 4242, startTime: new Date(Date.now() - 5_000) });
    let asked: readonly string[] = [];
    await captureSandboxDenies(process, {
      runLogQuery: async (args) => {
        asked = args;
        return "";
      },
    });
    assert.equal(asked[0], "show");
    assert.deepEqual(asked.slice(1, 4), ["--style", "ndjson", "--predicate"]);
    assert.match(String(asked[4]), /process=="kernel"/);
    assert.match(String(asked[4]), /Sandbox:/);
    assert.equal(asked[5], "--last");
    assert.equal(Number(asked[6]) >= 5, true);
  });
});
