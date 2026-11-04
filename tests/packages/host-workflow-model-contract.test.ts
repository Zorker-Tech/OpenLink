import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  WORKFLOW_FILENAME,
  LEGACY_WORKFLOW_FILENAME,
  WORKFLOW_INJECTED_BODY_LIMIT,
  WORKFLOW_MAX_BODY_LENGTH,
  WORKFLOW_MAX_DESCRIPTION_LENGTH,
  WORKFLOW_MAX_NAME_LENGTH,
  WORKFLOW_MAX_PER_AGENT,
  WORKFLOW_UI_LIMIT,
  agentSkillsFromWorkflows,
  automationToWorkflow,
  buildLiveSourcePointerBody,
  clampWorkflowBody,
  clampWorkflowDescription,
  clampWorkflowName,
  collectMentionedWorkflows,
  collectWorkflowReferences,
  deriveWorkflowNameFromMarkdown,
  deriveWorkflowNameFromUrl,
  limitSurfacedWorkflows,
  liveWorkflowSpecFromSource,
  parseWorkflowFile,
  promptReferencesWorkflow,
  renderWorkflowsSystemPrompt,
  serializeWorkflowFile,
  slugifyWorkflowName,
  workflowDir,
  workflowSpecFromMarkdown,
  workflowToAutomation,
  type WorkflowRecord,
} from "../../source/shared/workflow-model.ts";

function workflow(overrides: Partial<WorkflowRecord> = {}): WorkflowRecord {
  return {
    id: "flow-1",
    name: "Draft",
    description: "Description",
    body: "Follow the steps.",
    trigger: null,
    source: "workflow",
    sourceRef: null,
    isEnabledForAgent: true,
    createdAt: 10,
    helperScripts: [],
    filePath: "/workflows/draft/SKILL.md",
    ...overrides,
  };
}

describe("workflow model contract", () => {
  it("publishes the file names and bounds used by the workflow store", () => {
    assert.equal(WORKFLOW_FILENAME, "SKILL.md");
    assert.equal(LEGACY_WORKFLOW_FILENAME, "workflow.md");
    assert.equal(WORKFLOW_MAX_NAME_LENGTH, 80);
    assert.equal(WORKFLOW_MAX_DESCRIPTION_LENGTH, 1_536);
    assert.equal(WORKFLOW_MAX_BODY_LENGTH, 100_000);
    assert.equal(WORKFLOW_INJECTED_BODY_LIMIT, 8_000);
    assert.equal(WORKFLOW_UI_LIMIT, 100);
    assert.equal(WORKFLOW_MAX_PER_AGENT, 100);
  });

  it("normalizes bounded names and descriptions on one line and trims bodies", () => {
    assert.equal(clampWorkflowName("  Plan\nfor Monday  "), "Plan for Monday");
    assert.equal(clampWorkflowDescription("first\r\nsecond"), "first second");
    assert.equal(clampWorkflowBody("  first\nsecond  "), "first\nsecond");
    assert.equal(clampWorkflowName(5), "");
    assert.equal(clampWorkflowDescription(null), "");
    assert.equal(clampWorkflowBody({ text: "x" }), "");
    assert.equal(clampWorkflowName("n".repeat(WORKFLOW_MAX_NAME_LENGTH + 5)).length, WORKFLOW_MAX_NAME_LENGTH);
    assert.equal(clampWorkflowDescription("d".repeat(WORKFLOW_MAX_DESCRIPTION_LENGTH + 1)).length, WORKFLOW_MAX_DESCRIPTION_LENGTH);
    assert.equal(clampWorkflowBody("b".repeat(WORKFLOW_MAX_BODY_LENGTH + 1)).length, WORKFLOW_MAX_BODY_LENGTH);
  });

  it("slugifies unicode, punctuation, repeated separators, and an empty result", () => {
    assert.equal(slugifyWorkflowName("Café / Planning!!!"), "cafe-planning");
    assert.equal(slugifyWorkflowName("---already---clean---"), "already-clean");
    assert.equal(slugifyWorkflowName("東京"), "workflow");
    assert.equal(slugifyWorkflowName("A".repeat(80)).length, 64);
  });

  it("parses nested frontmatter scalars, trims the body, and reads metadata source", () => {
    const parsed = parseWorkflowFile(`---
name: "  Weekly Plan  "
description: 'Keep the handoff ready'
trigger:
  schedule: "0 9 * * 1"
  enabled: false
metadata:
  source: "workflow://weekly"
  revision: 3
extra:
  active: true
---

  Review the incoming work.
`);
    assert.ok(parsed);
    assert.equal(parsed.name, "Weekly Plan");
    assert.equal(parsed.description, "Keep the handoff ready");
    assert.equal(parsed.body, "Review the incoming work.");
    assert.deepEqual(parsed.trigger, { schedule: "0 9 * * 1", isEnabled: false });
    assert.equal(parsed.sourceRef, "workflow://weekly");
    assert.equal(parsed.data.extra && (parsed.data.extra as Record<string, unknown>).active, true);
    assert.equal((parsed.data.metadata as Record<string, unknown>).revision, 3);
  });

  it("accepts plain markdown and treats empty or malformed frontmatter defensively", () => {
    assert.deepEqual(parseWorkflowFile("Just a body."), {
      name: "", description: "", trigger: null, body: "Just a body.", sourceRef: null, data: {},
    });
    assert.equal(parseWorkflowFile(""), null);
    assert.equal(parseWorkflowFile("   \n  \t"), null);
    assert.deepEqual(parseWorkflowFile("---\nname: broken\nno closing fence"), {
      name: "", description: "", trigger: null, body: "---\nname: broken\nno closing fence", sourceRef: null, data: {},
    });
    assert.deepEqual(parseWorkflowFile("---\nname: 'ok'\n---\n"), {
      name: "ok", description: "", trigger: null, body: "", sourceRef: null, data: { name: "ok" },
    });
  });

  it("normalizes schedule whitespace and disables only an explicit false value", () => {
    const parsed = parseWorkflowFile(`---
trigger:
  schedule: "  0   12 * * 2  "
  enabled: "false"
---
run`);
    assert.deepEqual(parsed?.trigger, { schedule: "0 12 * * 2", isEnabled: true });
    assert.equal(parseWorkflowFile("---\ntrigger:\n  schedule: '  '\n---\nrun")?.trigger, null);
    assert.equal(parseWorkflowFile("---\ntrigger:\n  schedule: '0 8 * * *'\n  enabled: false\n---\nrun")?.trigger?.isEnabled, false);
  });

  it("serializes a workflow while preserving unrelated frontmatter and metadata", () => {
    const text = serializeWorkflowFile({
      name: "New plan",
      description: "Keep the details",
      body: "\n  Step one.\nStep two.  \n",
      trigger: null,
    }, {
      source: "legacy://pointer",
      owner: "team",
      metadata: { source: "metadata://pointer", reviewer: "ops", count: 2 },
      custom: { enabled: true },
      trigger: { schedule: "old", enabled: true },
    });
    const parsed = parseWorkflowFile(text);
    assert.ok(parsed);
    assert.equal(parsed.name, "New plan");
    assert.equal(parsed.description, "Keep the details");
    assert.equal(parsed.body, "Step one.\nStep two.");
    assert.equal(parsed.sourceRef, "metadata://pointer");
    assert.equal(parsed.trigger, null);
    assert.equal(parsed.data.owner, "team");
    assert.deepEqual(parsed.data.custom, { enabled: true });
    assert.equal((parsed.data.metadata as Record<string, unknown>).reviewer, "ops");
    assert.equal(parsed.data.source, undefined);
  });

  it("lets an explicit sourceRef replace metadata and legacy source fields", () => {
    const parsed = parseWorkflowFile(serializeWorkflowFile({
      name: "Plan", description: "", body: "body", trigger: { schedule: "0 8 * * *", isEnabled: false }, sourceRef: "source://new",
    }, { source: "source://legacy", metadata: { source: "source://old", keep: "yes" } }));
    assert.equal(parsed?.sourceRef, "source://new");
    assert.equal((parsed?.data.metadata as Record<string, unknown>).keep, "yes");
    assert.equal(parsed?.data.source, undefined);
    assert.deepEqual(parsed?.trigger, { schedule: "0 8 * * *", isEnabled: false });
    assert.equal(parsed?.description, "");
  });

  it("carries a legacy source forward only when metadata has no source", () => {
    const parsed = parseWorkflowFile(serializeWorkflowFile({ name: "Plan", description: "", body: "body", trigger: null }, {
      source: "legacy://saved", metadata: { owner: "team" },
    }));
    assert.equal(parsed?.sourceRef, "legacy://saved");
    assert.equal((parsed?.data.metadata as Record<string, unknown>).owner, "team");
  });

  it("projects triggered workflows into automation and leaves untriggered ones alone", () => {
    assert.equal(workflowToAutomation(workflow()), null);
    const result = workflowToAutomation(workflow({
      trigger: { schedule: "0 10 * * 1", isEnabled: false },
      scheduleDescription: "Every Monday at ten",
      lastRunAt: 20,
      nextRunAt: 30,
      runs: [{ id: "run-1" }],
    }));
    assert.ok(result);
    assert.equal(result.id, "flow-1");
    assert.equal(result.prompt, "Follow the steps.");
    assert.equal(result.trigger.type, "cron");
    assert.equal(result.schedule, "0 10 * * 1");
    assert.equal(result.triggerDescription, "Every Monday at ten");
    assert.equal(result.isEnabled, false);
    assert.deepEqual(result.runs, [{ id: "run-1" }]);
  });

  it("falls back to a generated schedule description and empty run history", () => {
    const result = workflowToAutomation(workflow({ trigger: { schedule: "0 9 * * 1", isEnabled: true } }));
    assert.ok(result);
    assert.equal(result.triggerDescription.length > 0, true);
    assert.deepEqual(result.runs, []);
    assert.equal(result.lastRunAt, null);
    assert.equal(result.nextRunAt, null);
  });

  it("maps an automation back to a workflow and retains the source fields", () => {
    const result = automationToWorkflow({
      id: "routine-1", name: "Daily", prompt: "Do the work", trigger: { type: "cron", schedule: "0 8 * * *" },
      triggerDescription: "Every day", isEnabled: false, createdAt: 9, filePath: "/automation/daily/SKILL.md",
    });
    assert.deepEqual(result.trigger, { schedule: "0 8 * * *", isEnabled: false });
    assert.equal(result.body, "Do the work");
    assert.equal(result.source, "automation");
    assert.equal(result.isEnabledForAgent, true);
    assert.equal(result.scheduleDescription, "Every day");
    assert.deepEqual(result.helperScripts, []);
    assert.deepEqual(result.runs, []);
  });

  it("keeps non-cron automations as triggered workflows with an empty schedule", () => {
    const result = automationToWorkflow({
      id: "routine-2", name: "Other", prompt: "Run", trigger: { type: "event" }, triggerDescription: "On event",
      isEnabled: true, createdAt: 0, filePath: "/automation/other/SKILL.md",
    });
    assert.deepEqual(result.trigger, { schedule: "", isEnabled: true });
  });

  it("surfaces all managed and plugin workflows before the bounded user-defined tail", () => {
    const items = [
      ...Array.from({ length: WORKFLOW_UI_LIMIT + 5 }, (_, index) => ({ id: `user-${index}`, source: "workflow" as const })),
      { id: "managed", source: "managed" as const },
      { id: "plugin", source: "plugin" as const },
    ];
    const surfaced = limitSurfacedWorkflows(items);
    assert.equal(surfaced.length, WORKFLOW_UI_LIMIT + 2);
    assert.deepEqual(surfaced.slice(0, 2).map(item => item.id), ["managed", "plugin"]);
    assert.equal(surfaced.some(item => item.id === "user-99"), true);
    assert.equal(surfaced.some(item => item.id === "user-100"), false);
  });

  it("turns only enabled, untriggered, model-invocable workflows with paths into skills", () => {
    const items = [
      workflow({ id: "ready", filePath: "/skills/ready/SKILL.md" }),
      workflow({ id: "scheduled", trigger: { schedule: "0 8 * * *", isEnabled: true } }),
      workflow({ id: "disabled", isEnabledForAgent: false }),
      workflow({ id: "hidden", disableModelInvocation: true }),
      workflow({ id: "no-path", filePath: "" }),
    ];
    assert.deepEqual(agentSkillsFromWorkflows(items), [{ fullPath: "/skills/ready/SKILL.md", description: "Description" }]);
  });

  it("builds an import spec from markdown using the heading or the caller fallback", () => {
    const fromHeading = workflowSpecFromMarkdown("# Weekly review\n\nReview open work.");
    assert.deepEqual(fromHeading, { name: "Weekly review", description: "", body: "# Weekly review\n\nReview open work.", trigger: null, sourceRef: null });
    const fromFirstLine = workflowSpecFromMarkdown("Run the checklist.", "Imported plan");
    assert.equal(fromFirstLine?.name, "Run the checklist.");
    const fromFallback = workflowSpecFromMarkdown("#", "Imported plan");
    assert.equal(fromFallback?.name, "Imported plan");
    assert.equal(workflowSpecFromMarkdown(" ", "No body"), null);
    assert.equal(workflowSpecFromMarkdown("Body only")?.name, "Body only");
  });

  it("builds live source specs with a trimmed source and a generated description", () => {
    const spec = liveWorkflowSpecFromSource({ name: "Review", source: "  https://example.test/skill.md  " });
    assert.equal(spec.name, "Review");
    assert.equal(spec.sourceRef, "https://example.test/skill.md");
    assert.equal(spec.trigger, null);
    assert.match(spec.description, /live reference/);
    assert.match(spec.body, /https:\/\/example\.test\/skill\.md/);
    assert.equal(buildLiveSourcePointerBody("skill://local").includes("source of truth"), true);
  });

  it("uses an explicit live-source description after trimming and bounding it", () => {
    const spec = liveWorkflowSpecFromSource({ name: "Plan", source: "path://one", description: "  Short note  " });
    assert.equal(spec.description, "Short note");
    assert.equal(liveWorkflowSpecFromSource({ name: "Plan", source: "path://one", description: "d".repeat(WORKFLOW_MAX_DESCRIPTION_LENGTH + 2) }).description.length, WORKFLOW_MAX_DESCRIPTION_LENGTH);
  });

  it("derives a workflow name from the first non-empty markdown line", () => {
    assert.equal(deriveWorkflowNameFromMarkdown("\n  # **Weekly** _review_  \nsecond line"), "Weekly review");
    assert.equal(deriveWorkflowNameFromMarkdown("- First item\n# Later heading"), "- First item");
    assert.equal(deriveWorkflowNameFromMarkdown("  \n  "), null);
  });

  it("derives URL names from the last path segment and tolerates invalid URLs", () => {
    assert.equal(deriveWorkflowNameFromUrl("https://example.test/skills/daily-checklist.md?download=1"), "daily checklist");
    assert.equal(deriveWorkflowNameFromUrl("https://example.test/a/path_name.MARKDOWN"), "path name");
    assert.equal(deriveWorkflowNameFromUrl("not a url"), "not a url");
    assert.equal(deriveWorkflowNameFromUrl("https://example.test/"), "Imported skill");
  });

  it("collects nested rich-text references once and keeps only string teaching scopes", () => {
    const richText = JSON.stringify({ type: "doc", content: [
      { type: "paragraph", content: [{ type: "workflowReference", attrs: { id: "alpha", teachQueueScope: "a1b2" } }] },
      { type: "workflowReference", attrs: { id: "alpha", teachQueueScope: 7 } },
      { type: "workflowReference", attrs: { id: "beta", teachQueueScope: "" } },
      { type: "workflowReference", attrs: { id: "" } },
    ] });
    assert.deepEqual(collectWorkflowReferences(richText), [
      { id: "alpha", teachQueueScope: "a1b2" },
      { id: "beta", teachQueueScope: "" },
    ]);
    assert.deepEqual(collectWorkflowReferences("not json"), []);
    assert.deepEqual(collectWorkflowReferences(undefined), []);
  });

  it("collects workflow mentions by id, full name, compact handle, and explicit reference", () => {
    const items = [{ id: "daily-plan", name: "Daily Plan" }, { id: "deploy", name: "Deploy" }];
    assert.deepEqual(collectMentionedWorkflows("Use @daily plan", items).map(item => item.id), ["daily-plan"]);
    assert.deepEqual(collectMentionedWorkflows("Use @dailyplan", items).map(item => item.id), ["daily-plan"]);
    assert.deepEqual(collectMentionedWorkflows("[plan](slate-workflow:deploy)", items).map(item => item.id), ["deploy"]);
    assert.equal(promptReferencesWorkflow("please run @DEPLOY", items[1]!), true);
    assert.equal(promptReferencesWorkflow("mail@deploy.example", items[1]!), false);
    assert.equal(promptReferencesWorkflow("@deployment", items[1]!), false);
  });

  it("deduplicates a workflow named in both rich text and an at-mention", () => {
    const items = [{ id: "deploy", name: "Deploy" }];
    assert.deepEqual(collectMentionedWorkflows("[Deploy](slate-workflow:deploy) then @deploy", items), items);
  });

  it("lets a longer overlapping handle claim its mention before a shorter one", () => {
    const items = [{ id: "server", name: "Server" }, { id: "server-tools", name: "Server-Tools" }];
    assert.deepEqual(collectMentionedWorkflows("Run @server-tools", items).map(item => item.id), ["server-tools"]);
  });

  it("finds parent folders with either separator and leaves a path without one intact", () => {
    assert.equal(workflowDir("/workflows/plan/SKILL.md"), "/workflows/plan");
    assert.equal(workflowDir("C:\\workflows\\plan\\SKILL.md"), "C:\\workflows\\plan");
    assert.equal(workflowDir("SKILL.md"), "SKILL.md");
  });

  it("renders no prompt without a location and names the shared library and reference syntax with one", () => {
    assert.equal(renderWorkflowsSystemPrompt(null), "");
    const prompt = renderWorkflowsSystemPrompt("/home/user/.slate/workflows");
    assert.match(prompt, /GLOBAL, shared library/);
    assert.match(prompt, /\/home\/user\/\.slate\/workflows/);
    assert.match(prompt, /slate-workflow:<id>/);
  });
});
