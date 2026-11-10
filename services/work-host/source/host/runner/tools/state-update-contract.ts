/** Slate's request vocabulary for changing durable state. Storage and runner behavior live in the host use case. */
import { z } from "zod";
import { GITHUB_EVENT_KINDS, LINEAR_EVENT_CASES, PAGERDUTY_EVENT_CASES, SENTRY_EVENT_CASES } from "../../../shared/automations.ts";
import type { StateWriteResult } from "../agent-state.ts";

export const SLATE_UPDATE_STATE_TOOL_NAME = "update_state";

export const OPERATIONS = {
  memory: {
    write: 'Store one durable fact (fact, tier, optional scope). The default scope is "agent"; use "user" for shared memory or "project" with a project slug. "profile" is long-lived, "log" is dated history, and "note" is short-lived. Duplicate facts are collapsed.',
    forget: "Remove a saved fact by its exact text and the same scope/project. Write the corrected fact separately.",
  },
  routine: {
    create: "Add a recurring task using a name, instructions, and one schedule or event trigger. Write the instructions for the next run, not for a fixed tool recipe.",
    update: "Change a routine by id. Supply only the name, instructions, schedule, trigger, or enabled value to change; every omitted value and its history stay as-is.",
    pause: "Pause the routine identified by id so it can be resumed later.",
    resume: "Resume the paused routine identified by id.",
    delete: "Remove the routine identified by id when it is no longer needed.",
  },
  workflow: {
    write: 'Save a reusable workflow with a name, description, and body; include an id to replace one. The description tells readers when it applies. Workflows are started by an agent, while scheduled work belongs in routines.',
    delete: "Remove the workflow identified by id. Platform-managed entries cannot be changed here.",
  },
  profile: { set: "Update your name, description, or both. Use the avatar target to change your picture." },
  settings: { set: "Change hidden_from_sidebar or notify_on_updates. Fields you leave out are preserved." },
  channel: { disconnect: "Disconnect the named platform; its live connection will close shortly." },
  project: {
    create: "Create a project from its slug and name, with an optional description, then join it. Creating an existing slug joins that project.",
    join: "Join the project named by its slug.",
    leave: "Leave the project named by its slug.",
  },
  avatar: {
    set: "Install an image already available on the box or host. A box path inside /workspace is accepted.",
    clear: "Restore the default picture.",
  },
} as const;

export type SlateStateTarget = keyof typeof OPERATIONS;
export type SlateStateAction = { [Target in SlateStateTarget]: keyof typeof OPERATIONS[Target] }[SlateStateTarget];
export const TARGETS = Object.keys(OPERATIONS) as SlateStateTarget[];
export const ACTIONS = [...new Set(Object.values(OPERATIONS).flatMap((actions) => Object.keys(actions)))] as SlateStateAction[];

export type StoredTrigger = Readonly<Record<string, unknown>>;

export interface SlateStateUpdate {
  readonly target: SlateStateTarget;
  readonly action: SlateStateAction;
  readonly fact?: string;
  readonly tier?: "profile" | "log" | "note";
  readonly scope?: "agent" | "user" | "project";
  readonly project?: string;
  readonly id?: string;
  readonly name?: string;
  readonly prompt?: string;
  readonly schedule?: string;
  readonly trigger?: StoredTrigger | readonly StoredTrigger[];
  readonly enabled?: boolean;
  readonly description?: string;
  readonly body?: string;
  readonly hidden_from_sidebar?: boolean;
  readonly notify_on_updates?: boolean;
  readonly platform?: string;
  readonly path?: string;
}

const scheduleTrigger = z.object({
  type: z.literal("cron"),
  schedule: z.string().trim().min(1).describe('A five-field schedule in local time (for example, "0 7 * * *") or a supported shortcut such as "@daily" or "@every 30m". If the user gives an hour without a minute, reuse the minute from the request timestamp.'),
});
const chatTrigger = z.object({
  type: z.literal("slack"),
  channel: z.string().trim().min(1).describe('Choose a channel ("#eng"), direct message ("@dana"), or "*" for any location.'),
  match: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("mention") }),
    z.object({ kind: z.literal("keyword"), keyword: z.string().trim().min(1) }),
    z.object({ kind: z.literal("message") }),
    z.object({
      kind: z.literal("reaction"),
      emoji: z.array(z.string().trim().min(1)).optional().describe('Short reaction names without surrounding colons (for example, "eyes"). Leave empty to match every reaction.'),
      bySelf: z.boolean().optional().describe("Set true to match only reactions added by the user."),
    }),
  ]).describe("Select the message or reaction pattern that should start the routine."),
});
const repositoryTrigger = z.object({
  type: z.literal("github"),
  repo: z.string().trim().min(1).describe('One repository written as "owner/name". Wildcards are not accepted.'),
  events: z.array(z.enum(GITHUB_EVENT_KINDS)).min(1).describe("Choose one or more repository events that start the routine."),
  userAllowlist: z.array(z.string().trim().min(1)).optional().describe('Optionally limit eligible account names. An empty or missing list allows everyone; CI completion events do not use this filter.'),
  ciBranch: z.string().trim().min(1).optional().describe('Required for CI completion events. Name the single branch to watch; checks from pull requests are not included.'),
});
const teamChatTrigger = z.object({
  type: z.literal("microsoftTeams"),
  tenantId: z.string().trim().min(1).describe("The tenant identifier that owns the team."),
  teamId: z.string().optional().describe("One team identifier. Supply this or teamIds."),
  teamIds: z.array(z.string()).optional().describe("A set of team identifiers. Supply this or teamId."),
  channelIds: z.array(z.string()).optional().describe("Optionally restrict matches to these channel identifiers; an empty list includes every channel."),
  messageContains: z.string().optional().describe("Optionally require message text to contain this value."),
  messageContainsIsRegex: z.boolean().optional().describe("Treat messageContains as a regular expression when true."),
  blockUnauthenticatedTeamsUsers: z.boolean().optional().describe("When enabled, ignore messages from users without an authenticated identity."),
});
const issueTrackerTrigger = z.object({
  type: z.literal("linear"),
  event: z.discriminatedUnion("case", [
    z.object({ case: z.literal(LINEAR_EVENT_CASES[0]).describe("Start when an issue is created.") }),
    z.object({ case: z.literal(LINEAR_EVENT_CASES[1]).describe("Start when an issue changes status."), statusIds: z.array(z.string()).optional().describe("Optionally restrict matches to these status identifiers.") }),
    z.object({ case: z.literal(LINEAR_EVENT_CASES[2]).describe("Start when a cycle ends."), cycleIds: z.array(z.string()).optional().describe("Optionally restrict matches to these cycle identifiers.") }),
  ]).describe("Choose the issue or cycle event that starts this routine."),
  projectIds: z.array(z.string()).optional().describe("Optionally restrict issue matches to these project identifiers."),
  teamIds: z.array(z.string()).optional().describe("Optionally restrict issue matches to these team identifiers."),
});
const errorMonitoringTrigger = z.object({
  type: z.literal("sentry"),
  event: z.object({ case: z.enum(SENTRY_EVENT_CASES).describe("Select the issue event to watch.") }).describe("The event kind for this trigger."),
  projectIds: z.array(z.string()).optional().describe("Optionally limit matches to these project identifiers."),
});
const incidentTrigger = z.object({
  type: z.literal("pagerduty"),
  event: z.object({ case: z.enum(PAGERDUTY_EVENT_CASES).describe("Select the incident event to watch.") }).describe("The event kind for this trigger."),
  serviceIds: z.array(z.string()).optional().describe("Optionally limit matches to these service identifiers."),
});
const singleTrigger = z.discriminatedUnion("type", [scheduleTrigger, chatTrigger, repositoryTrigger, teamChatTrigger, issueTrackerTrigger, errorMonitoringTrigger, incidentTrigger]);
const routineTrigger = z.union([
  z.discriminatedUnion("type", [
    scheduleTrigger, chatTrigger, repositoryTrigger, teamChatTrigger, issueTrackerTrigger, errorMonitoringTrigger, incidentTrigger,
    z.object({ type: z.literal("group"), listeners: z.array(singleTrigger).min(1).describe("Any one of these fires the same prompt; cron members and listeners mix freely.") }),
  ]),
  z.array(singleTrigger).min(1).describe("Provide multiple members when any one of them should start the routine."),
]).describe("Choose an event trigger, or group several so any member can start the routine. Do not provide both this field and schedule.");

export const slateUpdateStateParameters = z.object({
  target: z.enum(TARGETS as [SlateStateTarget, ...SlateStateTarget[]]).describe("Select the area of Slate state to update."),
  action: z.enum(ACTIONS as [SlateStateAction, ...SlateStateAction[]]).describe(`Choose an operation. ${Object.entries(OPERATIONS).map(([target, actions]) => `${target}: ${Object.keys(actions).join(" | ")}`).join(". ")}.`),
  fact: z.string().trim().min(1).optional().describe("For memory operations, provide one complete fact. Forget requires the exact stored wording."),
  tier: z.enum(["profile", "log", "note"]).optional().describe("For a memory write, choose its retention tier; log is the default."),
  scope: z.enum(["agent", "user", "project"]).optional().describe("For memory only. Defaults to the current agent's scope."),
  project: z.string().trim().min(1).optional().describe("Provide the project slug for project-scoped memory and all project operations."),
  id: z.string().trim().min(1).optional().describe("Identify the routine or workflow to change. Routine creation and workflow creation can omit it."),
  name: z.string().trim().min(1).optional().describe("Supply a new profile name, or the name for a routine, workflow, or project. Routine updates may omit it."),
  prompt: z.string().trim().min(1).optional().describe("Instructions for a routine run. Describe the outcome to achieve so each run can use the current tools. Required on creation; omission during update preserves the saved instructions."),
  schedule: z.string().trim().min(1).optional().describe('Routine schedule in local time, such as "0 7 * * *", "@daily", or "@every 2h". Use schedule or trigger, not both; omitting both on update keeps the existing trigger.'),
  trigger: routineTrigger.optional(),
  enabled: z.boolean().optional().describe("For routine creation or update. New routines are enabled by default; omission on update preserves the current value."),
  description: z.string().trim().optional().describe("Describe when a workflow applies, set the profile description, or add an optional project summary."),
  body: z.string().trim().min(1).optional().describe("Markdown content for a workflow. Required when writing one."),
  hidden_from_sidebar: z.boolean().optional().describe("For settings only. Set whether the conversation is hidden from the sidebar."),
  notify_on_updates: z.boolean().optional().describe("For settings only. Set whether updates should produce notifications."),
  platform: z.string().trim().min(1).optional().describe("Name the connected platform to disconnect."),
  path: z.string().trim().min(1).optional().describe("Absolute image path for avatar.set. The file must already be available on the host or in the box workspace; accepted formats are png, jpg, webp, gif, and svg, under 5 MB."),
});

export interface AutomationRecord {
  readonly id: string;
  readonly name: string;
  readonly prompt: string;
  readonly trigger: StoredTrigger;
  readonly isEnabled: boolean;
}
export interface WorkflowRecord { readonly id: string; readonly name: string; readonly body: string }
export interface AutomationSpec { readonly name: string; readonly prompt: string; readonly trigger: StoredTrigger; readonly isEnabled?: boolean }
export interface AutomationReview {
  readonly operation: "create" | "update" | "workflow_body";
  readonly id?: string;
  readonly spec: AutomationSpec;
  readonly referencedWorkflows: readonly WorkflowRecord[];
  readonly referencingRoutines?: readonly Pick<AutomationRecord, "id" | "name" | "prompt">[];
}

type UpdateOutcome = StateWriteResult<string>;
export interface SlateStateWriter {
  writeMemory(args: { content: string; tier: string; scope: string; project?: string }): Promise<UpdateOutcome>;
  removeMemory(args: { content: string; scope: string; project?: string }): Promise<UpdateOutcome>;
  createAutomation(args: { spec: AutomationSpec }): Promise<UpdateOutcome>;
  updateAutomation(args: { id: string; spec: AutomationSpec }): Promise<UpdateOutcome>;
  setAutomationEnabled(args: { id: string; isEnabled: boolean }): Promise<UpdateOutcome>;
  deleteAutomation(args: { id: string }): Promise<UpdateOutcome>;
  writeWorkflow(args: { id?: string; name: string; description: string; body: string }): Promise<UpdateOutcome>;
  deleteWorkflow(args: { id: string }): Promise<UpdateOutcome>;
  updateProfile(args: { name?: string; description?: string }): Promise<UpdateOutcome>;
  updateSettings(args: { hiddenFromSidebar?: boolean; notifyOnAgentUpdates?: boolean }): Promise<UpdateOutcome>;
  disconnectChannel(args: { platform: string }): Promise<UpdateOutcome>;
  createProject(args: { slug: string; name: string; description?: string }): Promise<UpdateOutcome>;
  joinProject(args: { slug: string }): Promise<UpdateOutcome>;
  leaveProject(args: { slug: string }): Promise<UpdateOutcome>;
  setAvatar(args: { path: string }): Promise<UpdateOutcome>;
  clearAvatar(): Promise<UpdateOutcome>;
}

export interface SlateStateDependencies {
  readonly state: SlateStateWriter;
  readonly toolCallId?: string;
  readonly automationStore?: { list(): readonly AutomationRecord[] };
  readonly workflowStore?: { list(): readonly WorkflowRecord[] };
  readonly parseTrigger?: (trigger: StoredTrigger | readonly StoredTrigger[]) => StoredTrigger | null;
  readonly reviewAutomationWrite?: (review: AutomationReview, toolCallId?: string) => Promise<{ readonly allowed: boolean; readonly reason: string } | undefined>;
  readonly onListenerRoutineSaved?: (trigger: StoredTrigger) => Promise<string | undefined>;
  readonly assertNoPendingAutoReviewApproval?: () => void;
}
