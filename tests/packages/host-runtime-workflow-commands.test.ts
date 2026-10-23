/**
 * What a message means when it names a workflow: the expansion it produces, the context its mentions carry, and the
 * changes a caller can make to an agent's workflows.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { WorkflowCommands } from "../../source/host/transcript/workflow-commands.ts";
import { WORKFLOW_INJECTED_BODY_LIMIT } from "../../source/shared/workflow-model.ts";
import { WORKFLOW_REFERENCE_NODE_TYPE } from "../../source/shared/workflows.ts";

const richTextReferencing = (references: Array<{ id: string; teachQueueScope?: string }>) => JSON.stringify({
  type: "doc",
  content: references.map((reference) => ({ type: "paragraph", content: [{ type: WORKFLOW_REFERENCE_NODE_TYPE, attrs: reference }] })),
});

/** A workflow as this module reads one. */
const workflow = (over: Record<string, unknown> = {}) => ({ id: "nightly", name: "Nightly", description: "writes the notes", body: "1. Read the day, 2. Write it down", source: "user", sourceRef: null, pluginId: null, publishedByCurrentUser: false, isEnabledForAgent: true, filePath: "/workflows/nightly.md", trigger: null, helperScripts: [], createdAt: 1, lastRunAt: null, nextRunAt: null, runs: [], ...over });

/** A transcript manager as the commands use one, with the workflows of a session and of the store. */
function harness(options: { activeId?: string | null; workflows?: Array<Record<string, unknown>>; storeWorkflows?: Array<Record<string, unknown>>; isGroup?: boolean; roster?: Array<Record<string, unknown>>; emitAutomations?: boolean; imported?: unknown; liveImported?: unknown; automation?: unknown } = {}) {
  const calls: unknown[][] = [];
  const events: Array<[string, unknown]> = [];
  const sessionWorkflows = new Map<string, unknown>();
  let changeHandler: (() => void) | undefined;
  let all = options.workflows ?? [workflow()];
  const listeners = new Map<string, Set<(value: unknown) => void>>();
  const emitter = {
    emit: (topic: string, payload: unknown) => {
      events.push([topic, payload]);
      for (const listener of listeners.get(topic) ?? []) listener(payload);
    },
    on: (topic: string, listener: (value: unknown) => void) => {
      calls.push(["on", topic]);
      if (!listeners.has(topic)) listeners.set(topic, new Set());
      listeners.get(topic)!.add(listener);
    },
    off: (topic: string, listener: (value: unknown) => void) => {
      calls.push(["off", topic, listener]);
      listeners.get(topic)?.delete(listener);
    },
  };
  const store = {
    listAgentAutomations: (agentId: string) => { calls.push(["list-automations", agentId]); return [{ id: "automation-1" }]; },
    createAgentWorkflow: (agentId: string, spec: unknown) => { calls.push(["store-create", agentId, spec]); return options.storeWorkflows ?? [workflow()]; },
    updateAgentWorkflow: (agentId: string, workflowId: string, spec: unknown) => { calls.push(["store-update", agentId, workflowId, spec]); return options.storeWorkflows ?? [workflow()]; },
    removeAgentWorkflow: (agentId: string, workflowId: string) => { calls.push(["store-remove", agentId, workflowId]); return options.storeWorkflows ?? []; },
    setAgentWorkflowEnabled: (agentId: string, workflowId: string, isEnabled: boolean) => { calls.push(["store-enabled", agentId, workflowId, isEnabled]); return options.storeWorkflows ?? [workflow()]; },
    listAgentWorkflows: (agentId: string) => { calls.push(["list-workflows", agentId]); return options.storeWorkflows ?? [workflow()]; },
    getAgentWorkflow: (agentId: string, workflowId: string) => { calls.push(["get-workflow", agentId, workflowId]); return options.storeWorkflows?.[0] ?? workflow(); },
    importAgentWorkflowMarkdown: () => { calls.push(["store-import-markdown"]); return { imported: ["from-store"], skipped: [] }; },
    importAgentWorkflowSource: () => { calls.push(["store-import-source"]); return { imported: ["from-store"], skipped: [] }; },
    portAgentLocalSkills: () => { calls.push(["store-port-skills"]); return { imported: [], skipped: [] }; },
    getUserTimeZone: () => "UTC",
  };
  const workflows = {
    setOnChange: (handler?: () => void) => { calls.push(["set-on-change", handler !== undefined]); changeHandler = handler; },
    listAll: () => { calls.push(["list-all"]); return all; },
    get: (id: string) => all.find((candidate) => candidate.id === id) ?? null,
    create: (spec: unknown) => { calls.push(["create", spec]); },
    update: (id: string, spec: unknown) => { calls.push(["update", id, spec]); },
    remove: (id: string) => { calls.push(["remove", id]); },
    setEnabledForAgent: (id: string, isEnabled: boolean) => { calls.push(["set-enabled", id, isEnabled]); },
    importMarkdown: (markdown: string, fallbackName?: string) => { calls.push(["import-markdown", markdown, fallbackName ?? null]); return options.imported === undefined ? workflow({ id: "imported" }) : options.imported; },
    importLiveSource: (source: string, fallbackName?: string) => { calls.push(["import-source", source, fallbackName ?? null]); return options.liveImported === undefined ? workflow({ id: "imported" }) : options.liveImported; },
    portLocalSkills: (home: string, cwd: string) => { calls.push(["port-skills", home.length > 0, cwd.length > 0]); return { imported: [], skipped: [] }; },
  };
  // A conversation is on screen unless the caller says otherwise.
  const session = options.activeId === null ? undefined : { id: options.activeId ?? "agent-1", workflows };
  const manager = {
    sessionStore: store,
    sessions: { activeSession: session },
    automationRuntime: {
      enqueueAutomationLifecycleMutation: async (args: { agentId: string; mutation: () => unknown }) => { calls.push(["mutation", args.agentId]); return args.mutation(); },
      recordAutomationChangeEvents: (_session: unknown, source: string) => { calls.push(["change-events", source]); },
      recordInactiveAutomationChanges: (args: { source: string; agentId: string; before: unknown; after: unknown }) => {
        calls.push(["inactive-changes", args.source]);
        calls.push(["inactive-args", args]);
      },
      fireAutomation: async (args: unknown) => { calls.push(["fire", args]); },
    },
    roster: { emitter },
    shouldEmitAutomations: () => options.emitAutomations ?? true,
    groupChat: { isGroupSession: () => { calls.push(["is-group-session"]); return options.isGroup ?? false; } },
    listAgentsSync: () => options.roster ?? [],
    sendPrompt: async (prompt: string, sendOptions: { richText: string }) => { calls.push(["send-prompt", prompt, sendOptions.richText]); },
  };
  const commands = new WorkflowCommands(manager as never);
  return { commands, manager, session, workflows, calls, events, kinds: (of: string) => calls.filter((call) => call[0] === of), change: () => changeHandler?.(), setWorkflows: (next: Array<Record<string, unknown>>) => { all = next; } };
}

describe("the workflows a conversation can name", () => {
  it("expands what the message referenced, in front of what the user wrote", () => {
    const { commands, session } = harness();
    const prompt = commands.expandWorkflowReferences(session as never, "write them up", richTextReferencing([{ id: "nightly" }]));
    assert.equal(prompt.startsWith('The user invoked the "Nightly" workflow (folder nightly). Run it now.'), true);
    assert.equal(prompt.endsWith("write them up"), true);
    assert.equal(prompt.includes("writes the notes"), true);
    // Nothing to expand leaves the message exactly as it was written.
    assert.equal(commands.expandWorkflowReferences(session as never, "just talk", undefined), "just talk");
    assert.equal(commands.expandWorkflowReferences(session as never, "just talk", richTextReferencing([{ id: "missing" }])), "just talk");
    // A message that says nothing else is the expansion on its own.
    assert.equal(commands.expandWorkflowReferences(session as never, "", richTextReferencing([{ id: "nightly" }])).endsWith("write them up"), false);
  });

  it("leaves a workflow the agent does not have on alone, and carries the queue a recording was filed under", () => {
    // A workflow that is not enabled for this agent is not expanded — unless it came from an automation.
    const disabled = harness({ workflows: [workflow({ isEnabledForAgent: false })] });
    assert.equal(disabled.commands.expandWorkflowReferences(disabled.session as never, "hello", richTextReferencing([{ id: "nightly" }])), "hello");
    const fromAutomation = harness({ workflows: [workflow({ isEnabledForAgent: false, source: "automation" })] });
    assert.equal(fromAutomation.commands.expandWorkflowReferences(fromAutomation.session as never, "hello", richTextReferencing([{ id: "nightly" }])).startsWith("The user invoked"), true);
    // The scope a recording was queued under travels with the block, and only for the teaching workflow.
    const teaching = harness({ workflows: [workflow({ id: "learn-from-demonstration", name: "Learn" })] });
    const scope = "a".repeat(64);
    const expanded = teaching.commands.expandWorkflowReferences(teaching.session as never, "go", richTextReferencing([{ id: "learn-from-demonstration", teachQueueScope: scope }]));
    assert.equal(expanded.includes(`Teach recording queue scope: ${scope}`), true);
    const notAQueue = teaching.commands.expandWorkflowReferences(teaching.session as never, "go", richTextReferencing([{ id: "learn-from-demonstration", teachQueueScope: "not-a-queue" }]));
    assert.equal(notAQueue.includes("Teach recording queue scope"), false);
  });

  it("gives an agent's mentions their context, and only where they mean something", () => {
    const roster = [{ id: "session-1", name: "Me", description: "this conversation", isGroup: false }, { id: "agent-2", name: "Notes", description: "keeps notes", isGroup: false }, { id: "group-3", name: "Crew", description: "a group", isGroup: true, memberIds: ["session-1"] }, { id: "group-4", name: "Other", description: "not mine", isGroup: true, memberIds: ["someone-else"] }];
    const { commands, session } = harness({ roster, activeId: "session-1" });
    const withMention = commands.withMentionedAgentsContext(session as never, "ask @Notes about it", "ask @Notes about it");
    assert.equal(withMention.endsWith("ask @Notes about it"), true);
    assert.equal(withMention.includes("Notes"), true);
    // A group the conversation is not in is not part of what it can mention, and neither is the conversation itself.
    const group = commands.withMentionedAgentsContext(session as never, "tell @Crew", "tell @Crew");
    assert.equal(group.includes("Crew"), true);
    const foreign = commands.withMentionedAgentsContext(session as never, "tell @Other", "tell @Other");
    assert.equal(foreign, "tell @Other");
    // A message with nothing in it, and a group conversation, are both left as they came.
    assert.equal(commands.withMentionedAgentsContext(session as never, "", "already expanded"), "already expanded");
    const asGroup = harness({ roster, activeId: "session-1", isGroup: true });
    assert.equal(asGroup.commands.withMentionedAgentsContext(asGroup.session as never, "ask @Notes", "ask @Notes"), "ask @Notes");
    // A message that mentions nobody is not given a context for nobody, and a conversation cannot mention itself.
    assert.equal(commands.withMentionedAgentsContext(session as never, "nothing to say", "nothing to say"), "nothing to say");
    assert.equal(commands.withMentionedAgentsContext(session as never, "ask @Me", "ask @Me"), "ask @Me");
  });

  it("changes an agent's workflows through its own session, or through the platform's store", async () => {
    // On screen the change goes through the session's own workflows, and both kinds of change are recorded.
    const active = harness({ activeId: "agent-1" });
    await active.commands.createAgentWorkflow("agent-1", { name: "Nightly" } as never);
    assert.deepEqual(active.kinds("create").length, 1);
    assert.deepEqual(active.kinds("change-events").map((call) => call[1]), ["agent", "workflow_ui"]);
    assert.deepEqual(active.kinds("store-create"), []);
    await active.commands.updateAgentWorkflow("agent-1", "nightly", { name: "Nightly" } as never);
    await active.commands.deleteAgentWorkflow("agent-1", "nightly");
    assert.deepEqual([active.kinds("update").length, active.kinds("remove").length], [1, 1]);
    await active.commands.setAgentWorkflowEnabled("agent-1", "nightly", false);
    assert.deepEqual(active.kinds("set-enabled").map((call) => [call[1], call[2]]), [["nightly", false]]);
    // A change answers with the list a caller is shown, which puts the managed workflows first.
    const ordered = harness({ activeId: "agent-1", workflows: [workflow({ id: "own" }), workflow({ id: "given", source: "managed" })] });
    assert.deepEqual((await ordered.commands.createAgentWorkflow("agent-1", { name: "New" } as never)).map((entry) => entry.id), ["given", "own"]);
    // Off screen it goes through the store, and what changed while the conversation was inactive is recorded as such.
    const offScreen = harness({ activeId: "agent-9" });
    await offScreen.commands.createAgentWorkflow("agent-1", { name: "Nightly" } as never);
    assert.deepEqual(offScreen.kinds("store-create").map((call) => call[1]), ["agent-1"]);
    assert.deepEqual(offScreen.kinds("inactive-changes").map((call) => call[1]), ["agent", "workflow_ui"]);
    await offScreen.commands.setAgentWorkflowEnabled("agent-1", "nightly", true);
    assert.deepEqual(offScreen.kinds("store-enabled").map((call) => [call[1], call[2], call[3]]), [["agent-1", "nightly", true]]);
    // With no conversation at all, the store is what answers.
    const none = harness({ activeId: null });
    assert.deepEqual(await none.commands.getAgentWorkflows("agent-1"), none.manager.sessionStore.listAgentWorkflows("agent-1"));
    assert.equal(await none.commands.getWorkflowForAgent("agent-1", "nightly") !== null, true);
    // On screen the list a caller gets is the limited one.
    const limited = harness({ activeId: "agent-1", workflows: [workflow({ id: "a" }), workflow({ id: "b" }), workflow({ id: "c" })], storeWorkflows: [workflow({ id: "stored" })] });
    assert.deepEqual((await limited.commands.getAgentWorkflows("agent-1")).map((entry) => entry.id), ["a", "b", "c"]);
    assert.deepEqual(await limited.commands.getAgentWorkflows("agent-2"), limited.manager.sessionStore.listAgentWorkflows("agent-2"));
  });

  it("tells whoever is listening about a conversation's workflows, and only about the one on screen", () => {
    const active = harness({ activeId: "agent-1" });
    // Watching a conversation attaches to its workflows once, and replaces what it watched before.
    active.commands.watchSessionWorkflows(active.session);
    assert.deepEqual(active.kinds("set-on-change").map((call) => call[1]), [true]);
    active.commands.watchSessionWorkflows(active.session);
    assert.deepEqual(active.kinds("set-on-change").length, 1);
    const other = harness({ activeId: "agent-1" });
    other.commands.watchSessionWorkflows(other.session);
    other.commands.watchSessionWorkflows({ id: "agent-1", workflows: { setOnChange: () => {}, listAll: () => [] } });
    // A change is only announced for the conversation the user is looking at, and only when the platform wants them.
    active.change();
    assert.deepEqual(active.events.map((event) => event[0]), ["workflows"]);
    assert.deepEqual((active.events[0]?.[1] as { agentId: string }).agentId, "agent-1");
    const quiet = harness({ activeId: "agent-1", emitAutomations: false });
    quiet.commands.watchSessionWorkflows(quiet.session);
    quiet.change();
    assert.deepEqual(quiet.events, []);
    const elsewhere = harness({ activeId: "agent-2" });
    let foreignChange: (() => void) | undefined;
    elsewhere.commands.watchSessionWorkflows({ id: "agent-1", workflows: { setOnChange: (handler?: () => void) => { foreignChange = handler; }, listAll: () => [] } });
    foreignChange?.();
    assert.deepEqual(elsewhere.events, []);
    // A listener hears what is emitted and stops when it stops listening.
    let heard = 0;
    active.commands.subscribeWorkflows(() => { heard += 1; });
    assert.equal(typeof active.commands.subscribeWorkflows(() => {}), "function");
    assert.equal(heard, 0);
  });

  it("imports a workflow from what the user pasted, linked or pointed at", async () => {
    const active = harness({ activeId: "agent-1" });
    const pasted = await active.commands.importAgentWorkflowMarkdown("agent-1", "---\nname: Nightly\n---\nbody", "Fallback") as { workflows: unknown[]; result: { imported: unknown[]; skipped: unknown[] } };
    assert.deepEqual(active.kinds("import-markdown").map((call) => [call[1], call[2]]), [["---\nname: Nightly\n---\nbody", "Fallback"]]);
    assert.deepEqual({ imported: pasted.result.imported.length, skipped: pasted.result.skipped.length }, { imported: 1, skipped: 0 });
    // What could not be read is reported as skipped rather than silently dropped.
    const unreadable = harness({ activeId: "agent-1", imported: null });
    const failed = await unreadable.commands.importAgentWorkflowMarkdown("agent-1", "nothing useful") as { result: { imported: unknown[]; skipped: Array<{ source: string; reason: string }> } };
    assert.deepEqual(failed.result.skipped, [{ source: "pasted skill", reason: "empty or invalid" }]);
    // A link that could not be taken on says so, and one that could is imported under the name it came with.
    const linked = harness({ activeId: "agent-1" });
    const imported = await linked.commands.importAgentWorkflowUrl("agent-1", "https://example.invalid/skills/nightly-notes.md") as { result: { imported: unknown[] } };
    assert.deepEqual(imported.result.imported.length, 1);
    assert.deepEqual(linked.kinds("import-source").map((call) => call[1]), ["https://example.invalid/skills/nightly-notes.md"]);
    const blind = harness({ activeId: "agent-1", liveImported: null });
    const skipped = await blind.commands.importAgentWorkflowUrl("agent-1", "https://example.invalid/x") as { result: { skipped: Array<{ reason: string }> } };
    assert.deepEqual(skipped.result.skipped.map((entry) => entry.reason), ["could not link"]);
    // Off screen the platform's store does the importing.
    const offScreen = harness({ activeId: "agent-9" });
    assert.deepEqual(await offScreen.commands.importAgentWorkflowMarkdown("agent-1", "x"), { imported: ["from-store"], skipped: [] });
    assert.deepEqual(await offScreen.commands.importAgentWorkflowSource("agent-1", "x"), { imported: ["from-store"], skipped: [] });
    assert.deepEqual(await offScreen.commands.portAgentLocalSkills("agent-1"), { imported: [], skipped: [] });
  });

  it("lays a workflow block out in the order a run reads it", () => {
    const helpers = harness({ workflows: [workflow({ id: "helpers", name: "Helpers", description: "uses files", body: "  follow the recipe  \n", helperScripts: ["run.sh", "notes.md"] })] });
    const expanded = helpers.commands.expandWorkflowReferences(helpers.session as never, "now", richTextReferencing([{ id: "helpers" }]));
    assert.equal(expanded, [
      'The user invoked the "Helpers" workflow (folder helpers). Run it now.',
      "What it does: uses files",
      "Recipe to follow:",
      "follow the recipe",
      "Helper files live beside this workflow in /workflows: run.sh, notes.md. Use them with Shell as the recipe directs.",
      "Carry out the recipe now, adapting it to anything else the user said in this message.",
      "",
      "now",
    ].join("\n"));

    // A workflow with nothing to say about itself and no helper files is its recipe and the instruction, nothing else.
    const plain = harness({ workflows: [workflow({ id: "plain", name: "Plain", description: "", body: "do it" })] });
    const plainExpanded = plain.commands.expandWorkflowReferences(plain.session as never, "", richTextReferencing([{ id: "plain" }]));
    assert.deepEqual(plainExpanded.split("\n"), [
      'The user invoked the "Plain" workflow (folder plain). Run it now.',
      "Recipe to follow:",
      "do it",
      "Carry out the recipe now, adapting it to anything else the user said in this message.",
    ]);

    // A long recipe is cut to the injected body limit, and the space around the recipe is not part of it.
    const long = harness({ workflows: [workflow({ id: "long", name: "Long", description: "d", body: "  " + "x".repeat(WORKFLOW_INJECTED_BODY_LIMIT + 50) + "  " })] });
    const longExpanded = long.commands.expandWorkflowReferences(long.session as never, "", richTextReferencing([{ id: "long" }]));
    assert.equal(longExpanded.includes("x".repeat(WORKFLOW_INJECTED_BODY_LIMIT)), true);
    assert.equal(longExpanded.includes("x".repeat(WORKFLOW_INJECTED_BODY_LIMIT + 1)), false);
  });

  it("says where each workflow came from and puts several blocks in front of the message", () => {
    const world = harness({ workflows: [
      workflow({ id: "m", name: "M", source: "managed" }),
      workflow({ id: "p", name: "P", source: "plugin", filePath: "/plugins/p/SKILL.md" }),
      workflow({ id: "u", name: "U", source: "user" }),
    ] });
    const expanded = world.commands.expandWorkflowReferences(world.session as never, "go", richTextReferencing([{ id: "m" }, { id: "p" }, { id: "u" }]));
    assert.equal(expanded.includes('The user invoked the "M" workflow (managed skill id m). Run it now.'), true);
    assert.equal(expanded.includes('The user invoked the "P" workflow (plugin skill id p, file /plugins/p/SKILL.md). Run it now.'), true);
    assert.equal(expanded.includes('The user invoked the "U" workflow (folder u). Run it now.'), true);
    const blocks = expanded.split("\n\n");
    assert.equal(blocks.at(-1), "go");
    assert.equal(blocks.length, 4);
  });

  it("gives the mention context a place only when there is a run prompt to put it in front of", () => {
    const roster = [{ id: "session-1", name: "Me", description: "this conversation", isGroup: false }, { id: "agent-2", name: "Notes", description: "keeps notes", isGroup: false }];
    const { commands, session, calls } = harness({ roster, activeId: "session-1" });
    const withPrompt = commands.withMentionedAgentsContext(session as never, "ask @Notes", "run this");
    const withoutPrompt = commands.withMentionedAgentsContext(session as never, "ask @Notes", "");
    assert.equal(withPrompt, withoutPrompt + "\n\nrun this");
    // An empty message never asks the group chat whether the conversation is a group.
    calls.length = 0;
    commands.withMentionedAgentsContext(session as never, "", "run this");
    assert.deepEqual(calls.filter((call) => call[0] === "is-group-session"), []);
  });

  it("records an off-screen change against the automations read before it and after it", async () => {
    const offScreen = harness({ activeId: "agent-9" });
    await offScreen.commands.createAgentWorkflow("agent-1", { name: "Nightly" } as never);
    // The automations are read once before the change and once after it; the first record is before against before.
    assert.equal(offScreen.kinds("list-automations").length, 2);
    assert.deepEqual(offScreen.kinds("inactive-args").map((call) => call[1]), [
      { agentId: "agent-1", before: [{ id: "automation-1" }], after: [{ id: "automation-1" }], source: "agent" },
      { agentId: "agent-1", before: [{ id: "automation-1" }], after: [{ id: "automation-1" }], source: "workflow_ui" },
    ]);
  });

  it("surfaces the managed workflows first and the agent's own after them", async () => {
    const world = harness({ activeId: "agent-1", workflows: [workflow({ id: "u1" }), workflow({ id: "m1", source: "managed" }), workflow({ id: "p1", source: "plugin" }), workflow({ id: "u2" })] });
    assert.deepEqual((await world.commands.getAgentWorkflows("agent-1")).map((entry) => entry.id), ["m1", "p1", "u1", "u2"]);
    // The store's answer off screen is passed through as it came.
    const stored = harness({ activeId: "agent-9", storeWorkflows: [workflow({ id: "stored" })] });
    assert.deepEqual((await stored.commands.getAgentWorkflows("agent-1")).map((entry) => entry.id), ["stored"]);
  });

  it("finds a workflow on the conversation on screen and in the store otherwise", async () => {
    const world = harness({ activeId: "agent-1", workflows: [workflow({ id: "active-one" })], storeWorkflows: [workflow({ id: "stored-one" })] });
    assert.equal((await world.commands.getWorkflowForAgent("agent-1", "active-one"))?.id, "active-one");
    assert.equal((await world.commands.getWorkflowForAgent("agent-2", "anything"))?.id, "stored-one");
  });

  it("answers an import with the workflows the agent now has, and takes a name from the link when none is given", async () => {
    const active = harness({ activeId: "agent-1" });
    const pasted = await active.commands.importAgentWorkflowMarkdown("agent-1", "body") as { workflows: Array<{ id: string }> };
    assert.deepEqual(pasted.workflows.map((entry) => entry.id), ["nightly"]);
    await active.commands.importAgentWorkflowUrl("agent-1", "https://example.invalid/skills/nightly-notes.md");
    assert.deepEqual(active.kinds("import-source").map((call) => call[2]), ["nightly notes"]);
    await active.commands.importAgentWorkflowUrl("agent-1", "https://example.invalid/x", "Chosen");
    assert.deepEqual(active.kinds("import-source").map((call) => call[2]), ["nightly notes", "Chosen"]);
  });

  it("ports local skills before it answers with the surfaced list", async () => {
    const active = harness({ activeId: "agent-1" });
    await active.commands.portAgentLocalSkills("agent-1");
    const portIndex = active.calls.findIndex((call) => call[0] === "port-skills");
    const listIndex = active.calls.findIndex((call) => call[0] === "list-all");
    assert.equal(portIndex >= 0 && listIndex > portIndex, true);
  });

  it("detaches from the workflows it watched before, and announces what a change left", () => {
    const world = harness({ activeId: "agent-1" });
    const sessionA = world.session;
    const foreign = { setOnChange: () => {}, listAll: () => [], get: () => null };
    world.commands.watchSessionWorkflows(sessionA);
    world.commands.watchSessionWorkflows({ id: "agent-1", workflows: foreign });
    assert.deepEqual(world.kinds("set-on-change").map((call) => call[1]), [true, false]);

    const active = harness({ activeId: "agent-1" });
    active.commands.watchSessionWorkflows(active.session);
    active.change();
    const payload = active.events[0]?.[1] as { agentId: string; workflows: Array<{ id: string }> };
    assert.deepEqual([active.events[0]?.[0], payload.agentId, payload.workflows.map((entry) => entry.id)], ["workflows", "agent-1", ["nightly"]]);
  });

  it("stops announcing to a listener that unsubscribed", () => {
    const active = harness({ activeId: "agent-1" });
    active.commands.watchSessionWorkflows(active.session);
    let heard = 0;
    const unsubscribe = active.commands.subscribeWorkflows(() => { heard += 1; });
    active.change();
    assert.equal(heard, 1);
    unsubscribe();
    active.change();
    assert.equal(heard, 1);
    assert.deepEqual(active.kinds("on").map((call) => call[1]), ["workflows"]);
    assert.deepEqual(active.kinds("off").map((call) => call[1]), ["workflows"]);
  });

  it("runs a workflow now, as a routine where it has a trigger and as a message where it does not", async () => {
    // A workflow with a trigger of its own is run as the routine it is — whoever it came from.
    const triggered = harness({ activeId: "agent-1", workflows: [workflow({ trigger: { schedule: "0 3 * * *", isEnabled: true } })] });
    await triggered.commands.runAgentWorkflowNow("agent-1", "nightly");
    assert.equal(triggered.kinds("fire").length, 1);
    assert.equal((triggered.kinds("fire")[0]?.[1] as { trigger: string }).trigger, "manual");
    assert.deepEqual(triggered.kinds("send-prompt"), []);
    // A workflow with no trigger of its own is run by sending the message that names it.
    const asMessage = harness({ activeId: "agent-1" });
    await asMessage.commands.runAgentWorkflowNow("agent-1", "nightly");
    assert.deepEqual(asMessage.kinds("fire"), []);
    const sent = asMessage.kinds("send-prompt")[0];
    assert.equal(sent?.[1], "@Nightly");
    assert.equal(String(sent?.[2]).includes(WORKFLOW_REFERENCE_NODE_TYPE), true);
    // The message names the workflow as one paragraph holding exactly one reference to it.
    assert.deepEqual(JSON.parse(String(sent?.[2])), {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: WORKFLOW_REFERENCE_NODE_TYPE,
              attrs: { id: "nightly", label: "Nightly" },
            },
          ],
        },
      ],
    });
    // A workflow that is not there runs nothing at all.
    const missing = harness({ activeId: "agent-1", workflows: [] });
    await missing.commands.runAgentWorkflowNow("agent-1", "nightly");
    assert.deepEqual(missing.kinds("send-prompt"), []);
    assert.deepEqual(missing.kinds("fire"), []);
  });
});