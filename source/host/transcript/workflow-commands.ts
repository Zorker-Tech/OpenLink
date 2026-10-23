/** What a message means when it names a workflow, an agent or a file.

 * A prompt is expanded against the workflows it names, the agents it mentions are given context, and the drafts a user
 * asked for are produced — with what the platform will not expand left exactly as it was written. */
import { homedir } from "node:os";
import { buildMentionedAgentsContext, type AgentAddress } from "../agents/agent-messaging.ts";
import { parseGroupMentions } from "../groups/group-chat.ts";
import {
  collectWorkflowReferences,
  deriveWorkflowNameFromUrl,
  limitSurfacedWorkflows,
  WORKFLOW_INJECTED_BODY_LIMIT,
  workflowDir,
  workflowToAutomation,
  type WorkflowRecord,
  type WorkflowSpec,
} from "../../shared/workflow-model.ts";
import { WORKFLOW_REFERENCE_NODE_TYPE } from "../../shared/workflows.ts";
import { AUTOMATION_WAKE_CUE } from "../../shared/automations.ts";
import { formatTimestamp } from "../../shared/automation-schedule.ts";
import type { TranscriptManagerLike } from "./transcript-hub.ts";


/** What triggered a workflow prompt: a message naming the workflow, or the workflow's own schedule. */
type WorkflowTrigger = "reference" | "schedule";

/** One workflow mentioned by a message's rich text. */
type WorkflowReference = ReturnType<typeof collectWorkflowReferences>[number];

/** The heading that separates a workflow's instructions from what surrounds them. */
const RECIPE_HEADING = "Recipe to follow:";

/** One lifecycle mutation, for the conversation on screen and for one that is not. */
interface WorkflowMutation<T> {
  readonly agentId: string;
  activeMutation(onScreen: any): T;
  inactiveMutation(): T;
}

/** Where a workflow came from, phrased the way the invoked line says it. */
function workflowIdentity(workflow: WorkflowRecord): string {
  if (workflow.source === "managed") return `managed skill id ${workflow.id}`;
  if (workflow.source === "plugin") return `plugin skill id ${workflow.id}, file ${workflow.filePath}`;
  return `folder ${workflow.id}`;
}

/** The lines a prompt opens with: a scheduled run wakes as a standing order, a named one was just invoked. */
function workflowOpeningLines(workflow: WorkflowRecord, trigger: WorkflowTrigger, timeZone?: string): string[] {
  if (trigger === "schedule") {
    return [
      `${AUTOMATION_WAKE_CUE} workflow "${workflow.name}" (folder ${workflow.id}) is due on its schedule — fired ${formatTimestamp(Date.now(), timeZone)}.`,
      "This is your own standing order firing on schedule, not a message the user just typed.",
    ];
  }
  return [`The user invoked the "${workflow.name}" workflow (${workflowIdentity(workflow)}). Run it now.`];
}

/** The instruction a workflow prompt ends on, which depends on why it is running. */
function workflowClosingInstruction(trigger: WorkflowTrigger): string {
  return trigger === "schedule"
    ? "Carry it out now and surface anything worth sharing with SendMessage, casually — unless the recipe says to stay quiet when there's nothing to report."
    : "Carry out the recipe now, adapting it to anything else the user said in this message.";
}

/** The line that points a run at the workflow's helper files, when the workflow has any. */
function workflowHelperFilesLine(workflow: WorkflowRecord): string | undefined {
  if (workflow.helperScripts.length === 0) return undefined;
  return `Helper files live beside this workflow in ${workflowDir(workflow.filePath)}: ${workflow.helperScripts.join(", ")}. Use them with Shell as the recipe directs.`;
}

/** The prompt one workflow run is given. */
function composeWorkflowRunPrompt(workflow: WorkflowRecord, trigger: WorkflowTrigger, timeZone?: string): string {
  const lines = workflowOpeningLines(workflow, trigger, timeZone);
  if (workflow.description.length > 0) lines.push(`What it does: ${workflow.description}`);
  lines.push(RECIPE_HEADING, workflow.body.trim().slice(0, WORKFLOW_INJECTED_BODY_LIMIT));
  const helperFiles = workflowHelperFilesLine(workflow);
  if (helperFiles !== undefined) lines.push(helperFiles);
  lines.push(workflowClosingInstruction(trigger));
  return lines.join("\n");
}

/** The rich text that names one workflow: a single paragraph holding its reference. */
function workflowReferenceDocument(workflow: WorkflowRecord): unknown {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: WORKFLOW_REFERENCE_NODE_TYPE,
            attrs: { id: workflow.id, label: workflow.name },
          },
        ],
      },
    ],
  };
}

/** Puts the expanded workflow sections in front of what the user wrote. */
function joinPromptSections(blocks: readonly string[], prompt: string): string {
  if (blocks.length === 0) return prompt;
  const sections = blocks.join("\n\n");
  return prompt.length > 0 ? `${sections}\n\n${prompt}` : sections;
}

/** Puts the mention context in front of the prompt the run was given. */
function prependContext(context: string, prompt: string): string {
  return prompt.length > 0 ? `${context}\n\n${prompt}` : context;
}

/** The workflow operations a conversation can make on the agent it belongs to. */
export class WorkflowCommands {
  /** The session's workflows the change callback is attached to, if any. */
  watchedWorkflows: any;

  constructor(readonly tm: TranscriptManagerLike) {}

  /** Runs one workflow mutation through the automation runtime, so the change is recorded beside the automations. */
  enqueueWorkflowMutation<T>(args: WorkflowMutation<T>): Promise<T> {
    return this.tm.automationRuntime.enqueueAutomationLifecycleMutation({
      agentId: args.agentId,
      mutation: () => this.applyWorkflowMutation(args),
    });
  }

  /** A mutation for the conversation on screen: the agent and the workflow list it touched are both recorded. */
  private applyWorkflowMutation<T>(args: WorkflowMutation<T>): T {
    const onScreen = this.tm.sessions.activeSession;
    if (onScreen?.id !== args.agentId) return this.applyOffScreenMutation(args);
    this.tm.automationRuntime.recordAutomationChangeEvents(onScreen, "agent");
    const changed = args.activeMutation(onScreen);
    this.tm.automationRuntime.recordAutomationChangeEvents(onScreen, "workflow_ui");
    return changed;
  }

  /** A mutation for a conversation that is not on screen: the automations are read before it and again after it. */
  private applyOffScreenMutation<T>(args: WorkflowMutation<T>): T {
    const automationsBefore = this.tm.sessionStore.listAgentAutomations(args.agentId);
    this.tm.automationRuntime.recordInactiveAutomationChanges({
      agentId: args.agentId,
      before: automationsBefore,
      after: automationsBefore,
      source: "agent",
    });
    const changed = args.inactiveMutation();
    const automationsAfter = this.tm.sessionStore.listAgentAutomations(args.agentId);
    this.tm.automationRuntime.recordInactiveAutomationChanges({
      agentId: args.agentId,
      before: automationsBefore,
      after: automationsAfter,
      source: "workflow_ui",
    });
    return changed;
  }

  /** Follows a conversation's workflow list, replacing whatever conversation was followed before. */
  watchSessionWorkflows(session: any): void {
    if (this.watchedWorkflows === session.workflows) return;
    this.watchedWorkflows?.setOnChange(undefined);
    this.watchedWorkflows = session.workflows;
    session.workflows.setOnChange(() => this.emitWorkflows(session));
  }

  /** Tells the app about a conversation's workflows, when it is the conversation the user is looking at. */
  emitWorkflows(session: any): void {
    if (this.tm.sessions.activeSession?.id !== session.id || !this.tm.shouldEmitAutomations()) return;
    this.tm.roster.emitter.emit("workflows", {
      agentId: session.id,
      workflows: this.surfacedWorkflows(session),
    });
  }

  /** Subscribes to the workflow announcements; the returned function stops the subscription. */
  subscribeWorkflows(listener: (value: unknown) => void): () => void {
    this.tm.roster.emitter.on("workflows", listener);
    return () => this.tm.roster.emitter.off("workflows", listener);
  }

  /** The conversation's own session, when it is the one on screen. */
  private sessionOnScreen(agentId: string): any {
    const onScreen = this.tm.sessions.activeSession;
    return onScreen?.id === agentId ? onScreen : undefined;
  }

  /** The workflows a caller gets to see, limited to what the app surfaces. */
  private surfacedWorkflows(session: any): WorkflowRecord[] {
    return limitSurfacedWorkflows(session.workflows.listAll());
  }

  async getAgentWorkflows(agentId: string): Promise<WorkflowRecord[]> {
    const session = this.sessionOnScreen(agentId);
    return session === undefined
      ? this.tm.sessionStore.listAgentWorkflows(agentId)
      : this.surfacedWorkflows(session);
  }

  createAgentWorkflow(agentId: string, spec: WorkflowSpec): Promise<WorkflowRecord[]> {
    return this.changeAgentWorkflows(agentId, (session) => session.workflows.create(spec), () => this.tm.sessionStore.createAgentWorkflow(agentId, spec));
  }

  updateAgentWorkflow(agentId: string, workflowId: string, spec: WorkflowSpec): Promise<WorkflowRecord[]> {
    return this.changeAgentWorkflows(agentId, (session) => session.workflows.update(workflowId, spec), () => this.tm.sessionStore.updateAgentWorkflow(agentId, workflowId, spec));
  }

  deleteAgentWorkflow(agentId: string, workflowId: string): Promise<WorkflowRecord[]> {
    return this.changeAgentWorkflows(agentId, (session) => session.workflows.remove(workflowId), () => this.tm.sessionStore.removeAgentWorkflow(agentId, workflowId));
  }

  /** Changes an agent's workflow list in either place, and answers with the list the caller sees. */
  private changeAgentWorkflows(
    agentId: string,
    changeOnScreen: (session: any) => void,
    changeOffScreen: () => WorkflowRecord[],
  ): Promise<WorkflowRecord[]> {
    return this.enqueueWorkflowMutation<WorkflowRecord[]>({
      agentId,
      activeMutation: (session) => {
        changeOnScreen(session);
        return this.surfacedWorkflows(session);
      },
      inactiveMutation: () => changeOffScreen(),
    });
  }

  async setAgentWorkflowEnabled(agentId: string, workflowId: string, isEnabled: boolean): Promise<WorkflowRecord[]> {
    const session = this.sessionOnScreen(agentId);
    if (session === undefined) return this.tm.sessionStore.setAgentWorkflowEnabled(agentId, workflowId, isEnabled);
    session.workflows.setEnabledForAgent(workflowId, isEnabled);
    return this.surfacedWorkflows(session);
  }

  async importAgentWorkflowMarkdown(agentId: string, markdown: string, fallbackName?: string): Promise<unknown> {
    const session = this.sessionOnScreen(agentId);
    if (session === undefined) return this.tm.sessionStore.importAgentWorkflowMarkdown(agentId, markdown, fallbackName);
    const imported = session.workflows.importMarkdown(markdown, fallbackName);
    return this.importedWorkflows(session, imported, {
      imported: [],
      skipped: [{ source: "pasted skill", reason: "empty or invalid" }],
    });
  }

  async importAgentWorkflowSource(agentId: string, source: string, fallbackName?: string): Promise<unknown> {
    const session = this.sessionOnScreen(agentId);
    if (session === undefined) return this.tm.sessionStore.importAgentWorkflowSource(agentId, source, fallbackName);
    const imported = session.workflows.importLiveSource(source, fallbackName);
    return this.importedWorkflows(session, imported, {
      imported: [],
      skipped: [{ source, reason: "could not link" }],
    });
  }

  /** What an import answers: the workflows the agent now has, and what was taken on or skipped. */
  private importedWorkflows(session: any, imported: unknown, skipped: unknown): unknown {
    return {
      workflows: this.surfacedWorkflows(session),
      result: imported == null ? skipped : { imported: [imported], skipped: [] },
    };
  }

  importAgentWorkflowUrl(agentId: string, url: string, name?: string): Promise<unknown> {
    return this.importAgentWorkflowSource(agentId, url, name ?? deriveWorkflowNameFromUrl(url));
  }

  async portAgentLocalSkills(agentId: string): Promise<unknown> {
    const session = this.sessionOnScreen(agentId);
    if (session === undefined) return this.tm.sessionStore.portAgentLocalSkills(agentId);
    const result = session.workflows.portLocalSkills(homedir(), process.cwd());
    return { workflows: this.surfacedWorkflows(session), result };
  }

  async runAgentWorkflowNow(agentId: string, workflowId: string): Promise<void> {
    const workflow = await this.getWorkflowForAgent(agentId, workflowId);
    if (workflow == null) return;
    const automation = workflowToAutomation(workflow);
    if (automation != null) {
      await this.tm.automationRuntime.fireAutomation({ agentId, automation, trigger: "manual" });
      return;
    }
    await this.tm.sendPrompt(`@${workflow.name}`, { richText: JSON.stringify(workflowReferenceDocument(workflow)) });
  }

  async getWorkflowForAgent(agentId: string, workflowId: string): Promise<WorkflowRecord | null> {
    const session = this.sessionOnScreen(agentId);
    return session === undefined
      ? this.tm.sessionStore.getAgentWorkflow(agentId, workflowId)
      : session.workflows.get(workflowId);
  }

  /** Expands every workflow the message referenced into the prompt the run is given. */
  expandWorkflowReferences(session: any, prompt: string, richText?: string): string {
    const blocks: string[] = [];
    for (const reference of collectWorkflowReferences(richText)) {
      const block = this.workflowReferenceBlock(session, reference);
      if (block !== undefined) blocks.push(block);
    }
    return joinPromptSections(blocks, prompt);
  }

  /** One referenced workflow's block, or nothing when the agent does not get that workflow expanded. */
  private workflowReferenceBlock(session: any, reference: WorkflowReference): string | undefined {
    const workflow: WorkflowRecord | null = session.workflows.get(reference.id);
    if (workflow == null || (!workflow.isEnabledForAgent && workflow.source !== "automation")) return undefined;
    const block = composeWorkflowRunPrompt(workflow, "reference", this.tm.sessionStore.getUserTimeZone());
    const queueScope =
      workflow.id === "learn-from-demonstration" &&
      reference.teachQueueScope != null &&
      /^[a-f0-9]{64}$/.test(reference.teachQueueScope)
        ? reference.teachQueueScope
        : undefined;
    return queueScope === undefined ? block : `${block}\n\nTeach recording queue scope: ${queueScope}`;
  }

  /** Gives the message the context of the agents it mentions, where mentions mean anything. */
  withMentionedAgentsContext(session: any, rawPrompt: string, promptForRun: string): string {
    if (rawPrompt.length === 0 || this.tm.groupChat.isGroupSession(session)) return promptForRun;
    const context = buildMentionedAgentsContext(this.mentionedAgents(session, rawPrompt));
    return context == null ? promptForRun : prependContext(context, promptForRun);
  }

  /** The agents a message mentions, described the way the mention context needs them. */
  private mentionedAgents(session: any, rawPrompt: string): AgentAddress[] {
    const roster = this.tm
      .listAgentsSync()
      .filter(
        (agent: any) =>
          agent.id !== session.id &&
          (!agent.isGroup || agent.memberIds.includes(session.id)),
      );
    const { memberIds } = parseGroupMentions(rawPrompt, roster);
    return memberIds.flatMap((id) => {
      const agent = roster.find((candidate: any) => candidate.id === id);
      return agent == null
        ? []
        : [
            {
              id: agent.id,
              name: agent.name,
              description: agent.description,
              isGroup: agent.isGroup,
            },
          ];
    });
  }
}