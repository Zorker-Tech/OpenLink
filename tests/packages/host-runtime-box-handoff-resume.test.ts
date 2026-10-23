/**
 * Picking a conversation back up after the user was handed the box, authorized a server or connected a listener —
 * which prompt is used, what the badge says, and where a resume that fails is reported.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import { BoxHandoffResume } from "../../source/host/transcript/box-handoff-resume.ts";
import { SlateError } from "../../source/shared/errors/registry.ts";

type Call = { name: string; args: unknown[] };

/** A transcript manager with the store, the roster and the run surface a resume reaches for. */
function world(
  options: {
    canExecute?: boolean;
    gone?: boolean;
    sessionError?: Error;
    group?: boolean;
    applied?: boolean;
    setAwaitingError?: Error;
    getStatusError?: Error;
    runError?: Error;
    status?: Record<string, unknown>;
  } = {},
) {
  const calls: Call[] = [];
  const record = (name: string, ...args: unknown[]) => {
    calls.push({ name, args });
  };
  const session = { id: "agent-1" };
  const runner = {
    run: async (prompt: string, runOptions: Record<string, unknown>) => {
      record("run", prompt, runOptions);
      if (options.runError !== undefined) throw options.runError;
      return { sentMessageCount: 1, reacted: false, aborted: false };
    },
  };
  const tm = {
    execution: { canExecute: options.canExecute !== false },
    sessions: {
      isAgentGone: () => options.gone === true,
      resolveBackgroundSession: async (agentId: string) => {
        record("resolveBackgroundSession", agentId);
        if (options.sessionError !== undefined) throw options.sessionError;
        return session;
      },
    },
    sessionStore: {
      setAwaitingUserResponse: async (agentId: string, state: unknown) => {
        record("setAwaitingUserResponse", agentId, state);
        if (options.setAwaitingError !== undefined) throw options.setAwaitingError;
      },
      setAwaitingUserResponseForTab: async (agentId: string, tabId: string, state: unknown, tabOptions: unknown) => {
        record("setAwaitingUserResponseForTab", agentId, tabId, state, tabOptions);
        if (options.setAwaitingError !== undefined) throw options.setAwaitingError;
        return options.applied !== false;
      },
    },
    roster: { emitAgentUpdate: async (agentId: string) => record("emitAgentUpdate", agentId) },
    groupChat: { isGroupSession: () => options.group === true },
    runnerRegistry: { getRunner: (target: unknown) => { record("getRunner"); return runner; } },
    runLifecycle: {
      lastRequestIdBySession: new Map<string, string>([["agent-1", "req-4"]]),
      beginSessionRun: (target: unknown) => record("beginSessionRun"),
      endSessionRun: (target: unknown) => record("endSessionRun"),
      enqueueExclusiveRun: async (id: string, work: () => Promise<void>, meta: unknown) => {
        record("enqueueExclusiveRun", id, meta);
        return await work();
      },
    },
    ackObligations: {
      mintAckRunToken: (agentId: string) => {
        record("mintAckRunToken", agentId);
        return "ack-token-9";
      },
      retireAckRunToken: (agentId: string, token: string | undefined) => record("retireAckRunToken", agentId, token),
    },
    turnRuntime: {
      activeRequestPrompts: new Map<string, string>([["agent-1", "old"]]),
      activeRequestSources: new Map<string, string>(),
    },
    telemetry: { reportAgentError: (report: unknown) => record("reportAgentError", report) },
    trayErrors: { pushError: (error: unknown) => record("pushError", error) },
    foreverBox: {
      getStatus: async (args: unknown) => {
        record("getStatus", args);
        if (options.getStatusError !== undefined) throw options.getStatusError;
        return options.status ?? { agentId: "agent-1", state: "ready" };
      },
    },
    resolveBoxRequestEntry: async (agentId: string, requestId: string, resolution: string) => record("resolveBoxRequestEntry", agentId, requestId, resolution),
    emitForeverBoxStatus: async (agentId: string) => record("emitForeverBoxStatus", agentId),
    resumeAfterBoxHandoff: async (agentId: string, trigger: string) => record("resumeAfterBoxHandoff", agentId, trigger),
    handleAgentUpdate: () => undefined,
  };
  const resume = new BoxHandoffResume(tm);
  return {
    resume, tm, session, runner, calls,
    named: (name: string) => calls.filter((call) => call.name === name),
    lastPrompt: () => (calls.filter((call) => call.name === "run").at(-1)?.args[0] ?? null) as string | null,
  };
}

describe("the badge that says the user is being waited on", () => {
  it("sets and clears it, leaving it alone for an agent that is gone", async () => {
    const world1 = world();
    world1.resume.awaitingSink.set("agent-1", { tabId: "tab-1", kind: "question" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(world1.named("setAwaitingUserResponse")[0]?.args, ["agent-1", { tabId: "tab-1", kind: "question" }]);
    assert.deepEqual(world1.named("emitAgentUpdate")[0]?.args, ["agent-1"]);
    world1.resume.awaitingSink.clear("agent-1");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(world1.named("setAwaitingUserResponse")[1]?.args, ["agent-1", null]);
    // An agent that is gone has no badge to set.
    const gone = world({ gone: true });
    await gone.resume.applyAwaitingState("agent-1", { kind: "question" });
    assert.equal(gone.calls.length, 0);
    // A badge is advisory: a store that cannot set it does not interrupt anything.
    const failing = world({ setAwaitingError: new Error("no store") });
    await assert.doesNotReject(() => failing.resume.applyAwaitingState("agent-1", { kind: "question" }));
    assert.equal(failing.named("emitAgentUpdate").length, 0);
  });

  it("keeps a per-tab badge, and only announces it when it was actually applied", async () => {
    const world1 = world();
    world1.resume.awaitingSink.trySetForTab("agent-1", { tabId: "tab-2", kind: "question" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(world1.named("setAwaitingUserResponseForTab")[0]?.args, ["agent-1", "tab-2", { tabId: "tab-2", kind: "question" }, undefined]);
    assert.deepEqual(world1.named("emitAgentUpdate")[0]?.args, ["agent-1"]);
    world1.resume.awaitingSink.clearForTab("agent-1", "tab-2", { ifSinceBefore: 500 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(world1.named("setAwaitingUserResponseForTab")[1]?.args, ["agent-1", "tab-2", null, { ifSinceBefore: 500 }]);
    // A tab the store refused to change is not announced, and a stale tab is an expected race rather than a failure.
    const refused = world({ applied: false });
    await refused.resume.applyAwaitingStateForTab("agent-1", "tab-3", { kind: "question" });
    assert.equal(refused.named("emitAgentUpdate").length, 0);
    const stale = world({ sessionError: new Error("gone"), gone: true });
    await assert.doesNotReject(() => stale.resume.applyAwaitingStateForTab("agent-1", "tab-3", null));
    assert.equal(stale.calls.length, 0);
  });
});

describe("handing the box back", () => {
  it("resumes the conversation the handoff belonged to, once", async () => {
    const world1 = world();
    world1.resume.boxHandoffs.set("agent-1", { requestId: "req-box" });
    await world1.resume.handBackForeverBox("agent-1", "dismissed");
    assert.equal(world1.resume.boxHandoffs.has("agent-1"), false);
    assert.deepEqual(world1.named("resolveBoxRequestEntry")[0]?.args, ["agent-1", "req-box", "dismissed"]);
    assert.deepEqual(world1.named("emitForeverBoxStatus")[0]?.args, ["agent-1"]);
    assert.deepEqual(world1.named("resumeAfterBoxHandoff")[0]?.args, ["agent-1", "dismissed"]);
    // The badge that said the user was being waited on is cleared as the box comes back.
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(world1.named("setAwaitingUserResponse")[0]?.args, ["agent-1", null]);
    // A handoff that is no longer the current one is no decision at all.
    await world1.resume.handBackForeverBox("agent-1", "button");
    assert.equal(world1.named("resolveBoxRequestEntry").length, 1);
    assert.equal(world1.named("resumeAfterBoxHandoff").length, 1);
    assert.equal(world1.named("emitForeverBoxStatus").length, 1);
  });

  it("tells whoever is listening what the box's status is now", async () => {
    const world1 = world({ status: { agentId: "agent-1", state: "ready" } });
    const seen: unknown[] = [];
    const unsubscribe = world1.resume.subscribeForeverBox((status) => seen.push(status));
    await world1.resume.emitForeverBoxStatus("agent-1");
    // A copy is compared so the assertion does not narrow what `seen` holds.
    assert.deepEqual([...seen], [{ ...{ agentId: "agent-1", state: "ready" }, handoff: null }]);
    // The status carries the handoff the conversation is under, when there is one.
    world1.resume.boxHandoffs.set("agent-1", { requestId: "req-box" });
    await world1.resume.emitForeverBoxStatus("agent-1");
    assert.deepEqual((seen[1] as { handoff: unknown }).handoff, { requestId: "req-box" });
    unsubscribe();
    await world1.resume.emitForeverBoxStatus("agent-1");
    assert.equal(seen.length, 2);
    // A box that cannot be asked right now is not an error for the listeners.
    const failing = world({ getStatusError: new Error("recreating") });
    failing.resume.subscribeForeverBox(() => seen.push("never"));
    await assert.doesNotReject(() => failing.resume.emitForeverBoxStatus("agent-1"));
    assert.equal(seen.filter((value) => value === "never").length, 0);
  });
});

describe("what a resume says", () => {
  it("resumes a box handoff with the prompt its trigger calls for", async () => {
    const handed = world();
    await handed.resume.resumeAfterBoxHandoff("agent-1");
    assert.match(String(handed.lastPrompt()), /handed the box back to you/);
    assert.match(String(handed.lastPrompt()), /read-only Screenshot tool/);
    const dismissed = world();
    await dismissed.resume.resumeAfterBoxHandoff("agent-1", "dismissed");
    assert.match(String(dismissed.lastPrompt()), /dismissed your box help request/);
    assert.match(String(dismissed.lastPrompt()), /then stop and wait for their reply/);
    const closed = world();
    await closed.resume.resumeAfterBoxHandoff("agent-1", "viewer-closed");
    assert.match(String(closed.lastPrompt()), /closed the box desktop viewer/);
    assert.match(String(closed.lastPrompt()), /asking whether they finished/);
  });

  it("resumes after an authorization or a listener with what was connected", async () => {
    const mcp = world();
    await mcp.resume.resumeAfterMcpAuth("agent-1", "slack", "work-account");
    assert.match(String(mcp.lastPrompt()), /"slack \(work-account\)" MCP server finished authorizing/);
    assert.match(String(mcp.lastPrompt()), /nothing reaches the user unless it's inside a SendMessage/);
    // The default account is not spelled out.
    const plain = world();
    await plain.resume.resumeAfterMcpAuth("agent-1", "slack", "default");
    assert.match(String(plain.lastPrompt()), /"slack" MCP server finished authorizing/);
    // A listener says which platform it was, and Slack gets the invitation reminder.
    const slack = world();
    await slack.resume.resumeAfterListenerConnect("agent-1", "slack");
    assert.match(String(slack.lastPrompt()), /\[Slack is now connected/);
    assert.match(String(slack.lastPrompt()), /\/invite @Cursor/);
    const github = world();
    await github.resume.resumeAfterListenerConnect("agent-1", "github");
    assert.match(String(github.lastPrompt()), /\[GitHub is now connected/);
    assert.equal(String(github.lastPrompt()).includes("/invite"), false);
  });

  it("hands the prompt to a background run under its own source, and records what it cost", async () => {
    const world1 = world();
    await world1.resume.resumeWithHiddenPrompt("agent-1", "do the thing", "Could not resume");
    assert.deepEqual(world1.named("enqueueExclusiveRun")[0]?.args[1], { lane: "background", source: "handoff-resume", ackToken: "ack-token-9" });
    assert.deepEqual(world1.named("run")[0]?.args, ["do the thing", { hidden: true, ackToken: "ack-token-9", requestSource: "handoff-resume" }]);
    assert.equal(world1.tm.turnRuntime.activeRequestPrompts.has("agent-1"), false);
    assert.equal(world1.tm.turnRuntime.activeRequestSources.get("agent-1"), "handoff-resume");
    assert.deepEqual(world1.named("emitAgentUpdate")[0]?.args, ["agent-1"]);
    assert.deepEqual(world1.named("retireAckRunToken")[0]?.args, ["agent-1", "ack-token-9"]);
    assert.deepEqual(world1.named("endSessionRun").length, 1);
    // A resume that fails is reported and shown, then the run is still closed out.
    const failed = world({ runError: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) });
    await failed.resume.resumeWithHiddenPrompt("agent-1", "do the thing", "Could not resume");
    const report = failed.named("reportAgentError")[0]?.args[0] as Record<string, unknown>;
    assert.equal(report.source, "resume");
    assert.equal(report.requestId, "req-4");
    assert.deepEqual(report.error, { code: SlateError.streamReset()["code"], connectCode: undefined, errno: "ECONNRESET" });
    const pushed = failed.named("pushError")[0]?.args[0] as Record<string, unknown>;
    assert.equal(pushed.title, "Could not resume");
    assert.equal(pushed.detail, "socket hang up");
    assert.deepEqual([failed.named("retireAckRunToken").length, failed.named("endSessionRun").length], [1, 1]);
  });

  it("does not resume when turns cannot run, the conversation cannot be opened, or it is in a group", async () => {
    const cannotRun = world({ canExecute: false });
    await cannotRun.resume.resumeWithHiddenPrompt("agent-1", "x", "t");
    assert.equal(cannotRun.calls.length, 0);
    const unopenable = world({ sessionError: new Error("no session") });
    await unopenable.resume.resumeWithHiddenPrompt("agent-1", "x", "t");
    assert.equal(unopenable.named("run").length, 0);
    assert.equal(unopenable.named("beginSessionRun").length, 0);
    const group = world({ group: true });
    await group.resume.resumeWithHiddenPrompt("agent-1", "x", "t");
    assert.equal(group.named("getRunner").length, 0);
    assert.equal(group.named("run").length, 0);
  });
});

const hashOf = (text: string | null) => createHash("sha256").update(text ?? "").digest("hex");

describe("the whole resume prompts are stable", () => {
  it("says the same thing for every box hand-back trigger", async () => {
    for (const [trigger, expected] of [
      ["button", "19997a8b9432f381cac83c6cb9d1d9f2efb11f4be36745b6e2451670225c05ad"],
      ["dismissed", "2103a00354f46cd76c5aa0e859468084516b1fcc71afca9f10a693c9922eff73"],
      ["viewer-closed", "f3891ceb72e6d731bb571a22801d8f747833e0d5514ad191f400d0037d84a2fa"],
    ]) {
      const world1 = world();
      await world1.resume.resumeAfterBoxHandoff("agent-1", trigger as string);
      assert.equal(hashOf(world1.lastPrompt()), expected);
    }
  });
  it("says the same thing after MCP authorization and listener connection", async () => {
    const mcp = world();
    await mcp.resume.resumeAfterMcpAuth("agent-1", "github", "work");
    assert.equal(hashOf(mcp.lastPrompt()), "f6d46189a561332dd0f7813a2d34b8a332fd8f4c7bc68310341cda3e0357034f");
    for (const [platform, expected] of [
      ["slack", "c761889544e837ba8db8e24703967d0d81ee8ae0e395f79e38bd5c867dc3f943"],
      ["github", "88ccbed58d21c79551c62964db39ff9422a6c5ff131d0223b173712118fbb4ca"],
      ["teams", "88ccbed58d21c79551c62964db39ff9422a6c5ff131d0223b173712118fbb4ca"],
    ]) {
      const listener = world();
      await listener.resume.resumeAfterListenerConnect("agent-1", platform as string);
      assert.equal(hashOf(listener.lastPrompt()), expected);
    }
  });
});

describe("a resume that fails is titled for the moment it resumed", () => {
  it("uses the moment's own title in the tray error", async () => {
    const handoff = world({ runError: new Error("boom") });
    await handoff.resume.resumeAfterBoxHandoff("agent-1", "button");
    assert.equal((handoff.named("pushError")[0]?.args[0] as { title?: string }).title, "Agent failed to resume after box handoff");
    const mcp = world({ runError: new Error("boom") });
    await mcp.resume.resumeAfterMcpAuth("agent-1", "github", "work");
    assert.equal((mcp.named("pushError")[0]?.args[0] as { title?: string }).title, "Agent failed to resume after MCP authentication");
    const listener = world({ runError: new Error("boom") });
    await listener.resume.resumeAfterListenerConnect("agent-1", "slack");
    assert.equal((listener.named("pushError")[0]?.args[0] as { title?: string }).title, "Agent failed to resume after listener connect");
  });
});
