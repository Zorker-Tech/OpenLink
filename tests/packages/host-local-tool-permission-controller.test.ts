/**
 * What the local-tool permission controller allows, asks and remembers across tool calls, turns and setting changes.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SLATE_LOCAL_TOOLS_ABANDONED_MESSAGE,
  SLATE_LOCAL_TOOLS_ASK_EXPIRED_MESSAGE,
  SLATE_LOCAL_TOOLS_ASK_UNAVAILABLE_MESSAGE,
  SLATE_LOCAL_TOOLS_DENIED_MESSAGE,
  SLATE_LOCAL_TOOLS_DISABLED_MESSAGE,
  SLATE_LOCAL_TOOLS_PREPARATORY_MESSAGE,
  SLATE_LOCAL_TOOLS_STALE_TASK_MESSAGE,
  SLATE_LOCAL_TOOLS_TARGET_TOO_LARGE_MESSAGE,
  SLATE_LOCAL_TOOLS_UNAPPROVED_MESSAGE,
  type SlateLocalToolRequest,
  type SlateLocalToolScope,
} from "../../source/shared/local-tool-permission-machinery.ts";
import { SLATE_NO_LOCAL_MACHINE_MESSAGE } from "../../source/shared/local-exec-gateway.ts";
import type { SlateLocalToolPermission } from "../../source/shared/local-tool-permission.ts";
import {
  SLATE_LOCAL_TOOL_FORGOTTEN_AGENT_MEMORY,
  SLATE_LOCAL_TOOL_REFUSED_ACTION_MEMORY_PER_AGENT,
  SLATE_LOCAL_TOOL_SETTLED_ID_MEMORY,
  SLATE_LOCAL_TOOL_TARGET_MAX_CHARS,
  SLATE_LOCAL_TOOLS_ASK_CANCELLED_MESSAGE,
  SlateLocalToolPermissionController,
  type SlateLocalToolControllerEvent,
} from "../../source/host/extensions/local-tool-permission/local-tool-permission-controller.ts";

interface WorldOptions {
  readonly permission?: SlateLocalToolPermission;
  readonly askTtlMs?: number;
  readonly canAsk?: (agentId: string) => boolean;
  readonly hasLiveComputer?: (agentId: string) => boolean;
  readonly refuseSettingChange?: boolean;
}

function world(options: WorldOptions = {}) {
  let permission = options.permission ?? "ask";
  let nextId = 0;
  const events: SlateLocalToolControllerEvent[] = [];
  const retired: string[] = [];
  const controller = new SlateLocalToolPermissionController({
    getPermission: () => permission,
    setPermission: (value) => {
      if (options.refuseSettingChange) throw new Error("settings are read-only");
      permission = value;
    },
    ...(options.canAsk === undefined ? {} : { canAsk: options.canAsk }),
    ...(options.hasLiveComputer === undefined ? {} : { hasLiveComputer: options.hasLiveComputer }),
    ...(options.askTtlMs === undefined ? {} : { askTtlMs: options.askTtlMs }),
    now: () => 1_000,
    randomId: () => `request-${++nextId}`,
    onApprovalRetired: (id) => retired.push(id),
  });
  controller.subscribe((event) => events.push(event));
  return {
    controller,
    events,
    retired,
    permission: () => permission,
    setPermission: (value: SlateLocalToolPermission) => {
      permission = value;
    },
  };
}

function scope(overrides: Partial<SlateLocalToolScope> = {}): SlateLocalToolScope {
  return { agentId: "agent-a", toolCallId: "call-a", ...overrides };
}

function request(overrides: Partial<SlateLocalToolRequest> = {}): SlateLocalToolRequest {
  return { action: "run-command", target: "pwd", ...overrides };
}

function latestRequest(events: readonly SlateLocalToolControllerEvent[], type: "created" | "settled") {
  return [...events].reverse().find((event) => event.type === type)?.request;
}

describe("the standing local-tool choices", () => {
  it("blocks Never, asks under Ask, and lets Always through without creating an approval", async () => {
    const never = world({ permission: "never" });
    assert.deepEqual([never.controller.permission(), never.controller.blockedReason(), never.controller.requiresApproval()], [
      "never",
      SLATE_LOCAL_TOOLS_DISABLED_MESSAGE,
      false,
    ]);
    assert.deepEqual(await never.controller.authorize(scope(), request()), {
      allowed: false,
      reason: SLATE_LOCAL_TOOLS_DISABLED_MESSAGE,
    });

    const ask = world();
    assert.deepEqual([ask.controller.blockedReason(), ask.controller.requiresApproval()], [undefined, true]);
    assert.deepEqual(await ask.controller.authorize(undefined, request()), {
      allowed: false,
      reason: SLATE_LOCAL_TOOLS_UNAPPROVED_MESSAGE,
    });

    const always = world({ permission: "always" });
    assert.deepEqual(await always.controller.authorize(scope(), request()), { allowed: true });
    assert.equal(always.events.length, 0);
  });

  it("checks a standing command decision using the same ask flow", async () => {
    const current = world();
    const decision = current.controller.awaitDesktopStandingDecision({
      agentId: "agent-a",
      toolCallId: "call-a",
      command: "pwd",
      description: "Show the current folder",
    });
    assert.deepEqual(latestRequest(current.events, "created"), {
      id: "request-1",
      agentId: "agent-a",
      action: "run-command",
      target: "pwd",
      status: "pending",
      createdAtMs: 1_000,
      expiresAtMs: 601_000,
      description: "Show the current folder",
    });
    current.controller.resolveRequest("request-1", "allow-once");
    assert.deepEqual(await decision, { allowed: true, approvalId: "request-1" });
  });

  it("refuses to ask when the conversation has no ask surface or the computer is disconnected", async () => {
    const unavailable = world({ canAsk: () => false });
    assert.deepEqual(await unavailable.controller.authorize(scope(), request()), {
      allowed: false,
      reason: SLATE_LOCAL_TOOLS_ASK_UNAVAILABLE_MESSAGE,
    });

    const disconnected = world({ hasLiveComputer: () => false });
    assert.deepEqual(await disconnected.controller.authorize(scope(), request()), {
      allowed: false,
      reason: SLATE_NO_LOCAL_MACHINE_MESSAGE,
    });
  });

  it("creates a pending ask, trims its description, and records a one-shot approval until the call ends", async () => {
    const current = world();
    const decision = current.controller.authorize(scope(), request({ description: "  Show the current folder  " }));
    const created = latestRequest(current.events, "created");
    assert.deepEqual(
      [created?.id, created?.status, created?.createdAtMs, created?.expiresAtMs, created?.description],
      ["request-1", "pending", 1_000, 601_000, "Show the current folder"],
    );

    const settled = current.controller.resolveRequest("request-1", "allow-once");
    assert.equal(settled?.status, "allowed");
    assert.deepEqual(await decision, { allowed: true, approvalId: "request-1" });
    assert.deepEqual(current.controller.liveApprovalIds(), ["request-1"]);
    assert.equal(current.controller.wasSettled("request-1"), true);

    current.controller.completeScope(scope());
    assert.deepEqual([current.controller.liveApprovalIds(), current.retired], [[], ["request-1"]]);
  });

  it("joins identical pending requests and sends one decision to every waiter", async () => {
    const current = world();
    const first = current.controller.authorize(scope(), request());
    const second = current.controller.authorize(scope(), request({ description: "An ignored difference" }));
    assert.deepEqual(current.events.map((event) => event.type), ["created"]);
    assert.deepEqual(current.controller.getPendingRequestForAgent("agent-a")?.id, "request-1");

    current.controller.resolveRequest("request-1", "allow-once");
    assert.deepEqual(await Promise.all([first, second]), [
      { allowed: true, approvalId: "request-1" },
      { allowed: true, approvalId: "request-1" },
    ]);
    assert.deepEqual(current.events.map((event) => event.type), ["created", "settled"]);
  });

  it("cancels an individual waiter without cancelling its peers, then remembers a cancelled last waiter", async () => {
    const current = world();
    const firstAbort = new AbortController();
    const first = current.controller.authorize(scope(), request({ signal: firstAbort.signal }));
    const second = current.controller.authorize(scope(), request());
    firstAbort.abort();
    assert.deepEqual(await first, { allowed: false, reason: SLATE_LOCAL_TOOLS_ASK_CANCELLED_MESSAGE });
    assert.equal(current.controller.getPendingRequestById("request-1")?.status, "pending");

    current.controller.resolveRequest("request-1", "allow-once");
    assert.deepEqual(await second, { allowed: true, approvalId: "request-1" });

    const lastAbort = new AbortController();
    const lastWaiter = current.controller.authorize(scope({ toolCallId: "call-b" }), request({ signal: lastAbort.signal }));
    lastAbort.abort();
    assert.deepEqual(await lastWaiter, { allowed: false, reason: SLATE_LOCAL_TOOLS_ASK_CANCELLED_MESSAGE });
    assert.equal(latestRequest(current.events, "settled")?.status, "expired");
    assert.equal(current.controller.rememberedRefusalCount(), 1);
    assert.deepEqual(await current.controller.authorize(scope({ toolCallId: "call-c" }), request()), {
      allowed: false,
      reason: SLATE_LOCAL_TOOLS_ABANDONED_MESSAGE,
    });
  });

  it("expires an unanswered request and does not leave it pending", async () => {
    const current = world({ askTtlMs: 5 });
    const settledEvent = new Promise<SlateLocalToolControllerEvent>((resolve) => {
      current.controller.subscribe((event) => {
        if (event.type === "settled") resolve(event);
      });
    });
    const decision = current.controller.authorize(scope(), request());
    const event = await settledEvent;
    assert.deepEqual([event.request.status, event.request.id], ["expired", "request-1"]);
    assert.deepEqual(await decision, { allowed: false, reason: SLATE_LOCAL_TOOLS_ASK_EXPIRED_MESSAGE });
    assert.equal(current.controller.getPendingRequestById("request-1"), undefined);
  });
});

describe("the scope and approvals behind an ask", () => {
  it("rejects prep access and oversized targets before asking", async () => {
    const current = world();
    assert.deepEqual(await current.controller.authorize(scope({ action: "run-command" }), request({ action: "read-file" })), {
      allowed: false,
      reason: SLATE_LOCAL_TOOLS_PREPARATORY_MESSAGE,
    });
    assert.deepEqual(await current.controller.authorize(scope(), request({ target: "x".repeat(SLATE_LOCAL_TOOL_TARGET_MAX_CHARS + 1) })), {
      allowed: false,
      reason: SLATE_LOCAL_TOOLS_TARGET_TOO_LARGE_MESSAGE,
    });

    const aborted = new AbortController();
    aborted.abort();
    assert.deepEqual(await current.controller.authorize(scope(), request({ signal: aborted.signal })), {
      allowed: false,
      reason: SLATE_LOCAL_TOOLS_ASK_CANCELLED_MESSAGE,
    });
    assert.equal(current.events.length, 0);
  });

  it("reuses an approval for its exact action or for a resource it owns", async () => {
    const current = world();
    const first = current.controller.authorize(
      scope(),
      request({ resourcePath: "C:\\Users\\me\\terminals\\", outlivesScope: true }),
    );
    current.controller.resolveRequest("request-1", "allow-once");
    assert.deepEqual(await first, { allowed: true, approvalId: "request-1" });

    assert.deepEqual(
      await current.controller.authorize(scope(), request()),
      { allowed: true, approvalId: "request-1" },
      "the same action and target use the stored approval",
    );
    assert.deepEqual(
      await current.controller.authorize(
        scope({ action: "run-command" }),
        request({ action: "send-input", target: "y", attachToResourcePath: "C:/Users/me/terminals/" }),
      ),
      { allowed: true, approvalId: "request-1" },
    );
    assert.equal(current.events.filter((event) => event.type === "created").length, 1);
  });

  it("finds resource approvals without a tool-call id and preserves only outliving approvals after completion", async () => {
    const current = world();
    const short = current.controller.authorize(scope(), request({ target: "short" }));
    current.controller.resolveRequest("request-1", "allow-once");
    await short;
    const long = current.controller.authorize(
      scope({ toolCallId: "call-long" }),
      request({ target: "long", resourcePath: "/terminals", outlivesScope: true }),
    );
    current.controller.resolveRequest("request-2", "allow-once");
    await long;

    assert.deepEqual(
      await current.controller.authorize(
        { agentId: "agent-a" },
        request({ action: "send-input", target: "q", attachToResourcePath: "\\terminals" }),
      ),
      { allowed: true, approvalId: "request-2" },
    );
    current.controller.completeScope(scope({ toolCallId: "call-a" }));
    assert.deepEqual(current.controller.liveApprovalIds(), ["request-2"]);
    assert.deepEqual(current.retired, ["request-1"]);
  });

  it("retires approvals and ends pending asks when an agent starts another turn", async () => {
    const current = world();
    const approved = current.controller.authorize(scope(), request({ target: "approved" }));
    current.controller.resolveRequest("request-1", "allow-once");
    await approved;
    const pending = current.controller.authorize(scope({ toolCallId: "call-pending" }), request({ target: "pending" }));

    current.controller.beginTurn("agent-a");
    assert.deepEqual(await pending, { allowed: false, reason: SLATE_LOCAL_TOOLS_ASK_EXPIRED_MESSAGE });
    assert.equal(current.controller.directionEpoch("agent-a"), 1);
    assert.deepEqual(current.retired, ["request-1"]);
    assert.deepEqual(await current.controller.authorize(scope({ directionEpoch: 0 }), request({ target: "pending" })), {
      allowed: false,
      reason: SLATE_LOCAL_TOOLS_ABANDONED_MESSAGE,
    });
    const nextTurn = current.controller.authorize(scope({ directionEpoch: 1 }), request({ target: "new" }));
    assert.equal(latestRequest(current.events, "created")?.status, "pending");
    current.controller.resolveRequest("request-3", "deny");
    assert.deepEqual(await nextTurn, { allowed: false, reason: SLATE_LOCAL_TOOLS_DENIED_MESSAGE });
  });

  it("marks forgotten tasks stale until the next turn, then clears the per-agent refusal memory", async () => {
    const current = world();
    const pending = current.controller.authorize(scope(), request());
    current.controller.forgetAgent("agent-a");
    assert.deepEqual(await pending, { allowed: false, reason: SLATE_LOCAL_TOOLS_ASK_EXPIRED_MESSAGE });
    assert.equal(current.controller.retainedAgentIds().includes("agent-a"), false);
    assert.deepEqual(await current.controller.authorize(scope(), request({ target: "stale" })), {
      allowed: false,
      reason: SLATE_LOCAL_TOOLS_STALE_TASK_MESSAGE,
    });

    current.controller.beginTurn("agent-a");
    const next = current.controller.authorize(scope(), request({ target: "fresh" }));
    current.controller.resolveRequest("request-2", "allow-once");
    assert.deepEqual(await next, { allowed: true, approvalId: "request-2" });
  });
});

describe("permission changes and bounded memory", () => {
  it("turns a successful Always choice into a setting for every request still waiting", async () => {
    const current = world();
    const selected = current.controller.authorize(scope(), request({ target: "selected" }));
    const waiting = current.controller.authorize(scope({ toolCallId: "call-waiting" }), request({ target: "waiting" }));
    current.controller.resolveRequest("request-1", "always");

    assert.equal(current.permission(), "always");
    assert.deepEqual(await selected, { allowed: true, approvalId: "request-1" });
    assert.deepEqual(await waiting, { allowed: true });
    assert.equal(latestRequest(current.events, "settled")?.status, "always");
  });

  it("turns a Never choice into a denial for every request still waiting", async () => {
    const current = world();
    const selected = current.controller.authorize(scope(), request({ target: "selected" }));
    const waiting = current.controller.authorize(scope({ toolCallId: "call-waiting" }), request({ target: "waiting" }));
    current.controller.resolveRequest("request-1", "never");

    assert.equal(current.permission(), "never");
    assert.deepEqual(await Promise.all([selected, waiting]), [
      { allowed: false, reason: SLATE_LOCAL_TOOLS_DISABLED_MESSAGE },
      { allowed: false, reason: SLATE_LOCAL_TOOLS_DISABLED_MESSAGE },
    ]);
    assert.deepEqual(current.events.filter((event) => event.type === "settled").map((event) => event.request.status), [
      "never",
      "never",
    ]);
    assert.equal(current.controller.rememberedRefusalCount(), 1);
  });

  it("falls back to a one-time allow when settings cannot persist Always", async () => {
    const current = world({ refuseSettingChange: true });
    const pending = current.controller.authorize(scope(), request());
    current.controller.resolveRequest("request-1", "always");
    assert.deepEqual(await pending, { allowed: true, approvalId: "request-1" });
    assert.equal(current.permission(), "ask");
    assert.deepEqual(current.controller.liveApprovalIds(), ["request-1"]);
  });

  it("remembers a refusal until the next direction and clears it when Never changes back to Ask", async () => {
    const current = world();
    const denied = current.controller.authorize(scope(), request());
    current.controller.resolveRequest("request-1", "deny");
    await denied;
    assert.equal(current.controller.rememberedRefusalCount(), 1);

    assert.deepEqual(await current.controller.authorize(scope({ toolCallId: "call-2" }), request()), {
      allowed: false,
      reason: SLATE_LOCAL_TOOLS_ABANDONED_MESSAGE,
    });
    current.controller.beginTurn("agent-a");
    current.setPermission("never");
    current.controller.notePermissionChanged();
    assert.deepEqual(await current.controller.authorize(scope({ directionEpoch: 1 }), request({ target: "never" })), {
      allowed: false,
      reason: SLATE_LOCAL_TOOLS_DISABLED_MESSAGE,
    });
    // A settings change back to Ask drops refusal history from the previous Never period.
    current.setPermission("ask");
    current.controller.notePermissionChanged();
    assert.equal(current.permission(), "ask");
    assert.equal(current.controller.rememberedRefusalCount(), 0);
  });

  it("bounds remembered requests and settled identifiers per their declared limits", async () => {
    const current = world();
    for (let index = 0; index <= SLATE_LOCAL_TOOL_REFUSED_ACTION_MEMORY_PER_AGENT; index += 1) {
      const pending = current.controller.authorize(scope({ toolCallId: `call-${index}` }), request({ target: `cmd-${index}` }));
      current.controller.resolveRequest(`request-${index + 1}`, "deny");
      await pending;
    }
    assert.equal(current.controller.rememberedRefusalCount(), SLATE_LOCAL_TOOL_REFUSED_ACTION_MEMORY_PER_AGENT);
    assert.equal(current.controller.refusalFor(scope(), request({ target: "new-task" })), SLATE_LOCAL_TOOLS_STALE_TASK_MESSAGE);

    current.controller.beginTurn("agent-a");
    for (let index = 0; index < SLATE_LOCAL_TOOL_SETTLED_ID_MEMORY + 2; index += 1) {
      const id = `extra-${index}`;
      const pending = current.controller.authorize(scope({ toolCallId: id }), request({ target: id }));
      const requestId = `request-${SLATE_LOCAL_TOOL_REFUSED_ACTION_MEMORY_PER_AGENT + index + 2}`;
      current.controller.resolveRequest(requestId, "allow-once");
      await pending;
    }
    assert.equal(
      current.controller.wasSettled(`request-${SLATE_LOCAL_TOOL_REFUSED_ACTION_MEMORY_PER_AGENT + 2}`),
      false,
    );
    assert.equal(current.controller.wasSettled("request-1"), false);
    for (let index = 0; index <= SLATE_LOCAL_TOOL_FORGOTTEN_AGENT_MEMORY; index += 1) {
      current.controller.forgetAgent(`forgotten-${index}`);
    }
    assert.equal(current.controller.refusalFor(scope({ agentId: "forgotten-0" }), request()), undefined);
    assert.equal(
      current.controller.refusalFor(scope({ agentId: "forgotten-1" }), request()),
      SLATE_LOCAL_TOOLS_STALE_TASK_MESSAGE,
    );
  });
});
