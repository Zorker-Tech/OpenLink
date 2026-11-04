/** Apply Slate state updates through host-owned capabilities, keeping storage decisions in the supplied writer. */
import { slugifyWorkflowName } from "../../../shared/workflow-model.ts";
import { stateWriteOk, type StateWriteResult } from "../agent-state.ts";
import { defineCommunicateTool } from "./communicate-tool.ts";
import { SlateToolInputError } from "./tool-input-error.ts";
import {
  OPERATIONS,
  SLATE_UPDATE_STATE_TOOL_NAME,
  TARGETS,
  slateUpdateStateParameters,
  type AutomationRecord,
  type AutomationReview,
  type AutomationSpec,
  type SlateStateDependencies,
  type SlateStateTarget,
  type SlateStateUpdate,
  type StoredTrigger,
  type WorkflowRecord,
} from "./state-update-contract.ts";

export * from "./state-update-contract.ts";

type Outcome = StateWriteResult<string>;

function requireArgument<T>(value: T | null | undefined, field: string, args: SlateStateUpdate): T {
  if (value == null) throw new SlateToolInputError(`'${field}' is required for ${args.target} ${args.action}.`);
  return value;
}

function scheduledTrigger(schedule: string): StoredTrigger { return { type: "cron", schedule }; }

export function resolveTrigger(args: SlateStateUpdate, deps: SlateStateDependencies, fallback?: StoredTrigger): StoredTrigger {
  if (args.schedule != null && args.trigger != null) throw new SlateToolInputError("Choose one routine start condition: a schedule or an event trigger.");
  if (args.schedule != null) return scheduledTrigger(args.schedule);
  if (args.trigger != null) {
    const fallbackTrigger: StoredTrigger = Array.isArray(args.trigger)
      ? { type: "group", listeners: args.trigger }
      : args.trigger as StoredTrigger;
    const parsed = deps.parseTrigger === undefined
      ? fallbackTrigger
      : deps.parseTrigger(args.trigger);
    if (parsed == null) throw new SlateToolInputError(`that trigger isn't usable \u2014 check the channel, repo (one concrete "owner/name"), event names, the ciBranch a ci-passed/ci-failed listener needs, and the tenantId plus at least one team id a microsoftTeams trigger needs.`);
    return parsed;
  }
  return requireArgument(fallback, "schedule' or 'trigger", args);
}

function namesWorkflow(prompt: string, workflow: Pick<WorkflowRecord, "id" | "name">): boolean {
  const normalizedPrompt = prompt.toLowerCase();
  return [workflow.id, workflow.name].some((reference) => normalizedPrompt.includes(reference.toLowerCase()));
}

function workflowsForPrompt(prompt: string, deps: SlateStateDependencies): WorkflowRecord[] {
  return (deps.workflowStore?.list() ?? []).filter((workflow) => namesWorkflow(prompt, workflow));
}

async function saveRoutine(args: SlateStateUpdate, deps: SlateStateDependencies): Promise<Outcome> {
  const updating = args.action === "update";
  const id = updating ? requireArgument(args.id, "id", args) : undefined;
  const existing = id == null ? undefined : deps.automationStore?.list().find((routine) => routine.id === id);
  if (updating && deps.automationStore != null && existing == null) throw new SlateToolInputError(`no routine with folder "${id}" exists — list the automations folder, then pass its id.`);
  const spec: AutomationSpec = {
    name: args.name ?? requireArgument(existing?.name, "name", args),
    prompt: args.prompt ?? requireArgument(existing?.prompt, "prompt", args),
    trigger: resolveTrigger(args, deps, existing?.trigger),
    ...(args.enabled != null ? { isEnabled: args.enabled } : updating ? {} : { isEnabled: true }),
  };
  const review = await deps.reviewAutomationWrite?.({
    operation: updating ? "update" : "create",
    ...(id == null ? {} : { id }), spec, referencedWorkflows: workflowsForPrompt(spec.prompt, deps),
  }, deps.toolCallId);
  if (review != null && !review.allowed) return { ok: false, reason: review.reason };
  const outcome = id == null ? await deps.state.createAutomation({ spec }) : await deps.state.updateAutomation({ id, spec });
  if (!outcome.ok) return outcome;
  const note = await deps.onListenerRoutineSaved?.(spec.trigger);
  return note == null ? outcome : stateWriteOk(`${outcome.detail}\n${note}`);
}

async function saveWorkflow(args: SlateStateUpdate, deps: SlateStateDependencies): Promise<Outcome> {
  const name = requireArgument(args.name, "name", args);
  const body = requireArgument(args.body, "body", args);
  const description = requireArgument(args.description, "description", args);
  const existing = args.id == null ? undefined : deps.workflowStore?.list().find((workflow) => workflow.id === args.id);
  const workflowId = args.id ?? existing?.id ?? slugifyWorkflowName(name);
  const mentions = [{ id: workflowId, name }, ...(existing != null && existing.name !== name ? [{ id: existing.id, name: existing.name }] : [])];
  const referencing = (deps.automationStore?.list() ?? []).filter((routine) => mentions.some((target) => namesWorkflow(routine.prompt, target)));
  if (referencing.length > 0) {
    const anchor = referencing[0];
    if (anchor == null) throw new Error();
    const review = await deps.reviewAutomationWrite?.({
      operation: "workflow_body", ...(args.id == null ? {} : { id: args.id }),
      spec: { name, prompt: body, trigger: anchor.trigger, isEnabled: referencing.some((routine) => routine.isEnabled) },
      referencedWorkflows: [{ id: workflowId, name, body }],
      referencingRoutines: referencing.map(({ id, name: routineName, prompt }) => ({ id, name: routineName, prompt })),
    }, deps.toolCallId);
    if (review != null && !review.allowed) return { ok: false, reason: review.reason };
  }
  return deps.state.writeWorkflow({ ...(args.id == null ? {} : { id: args.id }), name, description, body });
}

type StateOperation = (args: SlateStateUpdate, deps: SlateStateDependencies) => Promise<Outcome>;
type StateOperationTable = {
  readonly [Target in SlateStateTarget]: {
    readonly [Action in keyof typeof OPERATIONS[Target]]: StateOperation;
  };
};

const STATE_OPERATIONS = {
  memory: {
    write: (args, deps) => deps.state.writeMemory({
      content: requireArgument(args.fact, "fact", args),
      tier: args.tier ?? "log",
      scope: args.scope ?? "agent",
      ...(args.project == null ? {} : { project: args.project }),
    }),
    forget: (args, deps) => deps.state.removeMemory({
      content: requireArgument(args.fact, "fact", args),
      scope: args.scope ?? "agent",
      ...(args.project == null ? {} : { project: args.project }),
    }),
  },
  routine: {
    create: saveRoutine,
    update: saveRoutine,
    pause: (args, deps) => deps.state.setAutomationEnabled({ id: requireArgument(args.id, "id", args), isEnabled: false }),
    resume: (args, deps) => deps.state.setAutomationEnabled({ id: requireArgument(args.id, "id", args), isEnabled: true }),
    delete: (args, deps) => deps.state.deleteAutomation({ id: requireArgument(args.id, "id", args) }),
  },
  workflow: {
    write: saveWorkflow,
    delete: (args, deps) => deps.state.deleteWorkflow({ id: requireArgument(args.id, "id", args) }),
  },
  profile: {
    set: (args, deps) => deps.state.updateProfile({
      ...(args.name == null ? {} : { name: args.name }),
      ...(args.description == null ? {} : { description: args.description }),
    }),
  },
  settings: {
    set: (args, deps) => deps.state.updateSettings({
      ...(args.hidden_from_sidebar == null ? {} : { hiddenFromSidebar: args.hidden_from_sidebar }),
      ...(args.notify_on_updates == null ? {} : { notifyOnAgentUpdates: args.notify_on_updates }),
    }),
  },
  channel: {
    disconnect: (args, deps) => deps.state.disconnectChannel({ platform: requireArgument(args.platform, "platform", args) }),
  },
  project: {
    create: (args, deps) => deps.state.createProject({
      slug: requireArgument(args.project, "project", args),
      name: requireArgument(args.name, "name", args),
      ...(args.description == null ? {} : { description: args.description }),
    }),
    join: (args, deps) => deps.state.joinProject({ slug: requireArgument(args.project, "project", args) }),
    leave: (args, deps) => deps.state.leaveProject({ slug: requireArgument(args.project, "project", args) }),
  },
  avatar: {
    set: (args, deps) => deps.state.setAvatar({ path: requireArgument(args.path, "path", args) }),
    clear: (_args, deps) => deps.state.clearAvatar(),
  },
} satisfies StateOperationTable;

function stateOperation(value: string): StateOperation | undefined {
  const pieces = value.split(".");
  if (pieces.length !== 2) return undefined;
  const [target, action] = pieces;
  if (target == null || action == null || !Object.hasOwn(STATE_OPERATIONS, target)) return undefined;
  const actions = STATE_OPERATIONS[target as SlateStateTarget] as Readonly<Record<string, StateOperation>>;
  return Object.hasOwn(actions, action) ? actions[action] : undefined;
}

export function isSlateStateRoute(value: string): boolean {
  return stateOperation(value) !== undefined;
}

export async function applySlateStateUpdate(args: SlateStateUpdate, deps: SlateStateDependencies): Promise<Outcome> {
  const operation = stateOperation(`${args.target}.${args.action}`);
  if (operation === undefined) {
    if (Object.hasOwn(OPERATIONS, args.target)) {
      const supportedActions = Object.keys(OPERATIONS[args.target]).join(" | ");
      throw new SlateToolInputError(`'${args.action}' is not an action on ${args.target}. ${args.target} takes: ${supportedActions}.`);
    }
    throw new SlateToolInputError(`'${args.target}' is not a supported state target. Choose one of: ${TARGETS.join(" | ")}.`);
  }
  return operation(args, deps);
}

export function describeStateUpdate(args: SlateStateUpdate): string {
  if (args.target === "memory") return args.scope === "user" ? "user memory" : args.scope === "project" ? `project ${args.project ?? "memory"}` : "memory";
  if (args.target === "avatar") return "avatar";
  return args.name ?? args.project ?? args.id ?? args.platform ?? args.target;
}

export function createSlateStateTool(deps: SlateStateDependencies) {
  const operationLines = Object.entries(OPERATIONS).flatMap(([target, actions]) => Object.entries(actions).map(([action, text]) => `- ${target} ${action}: ${text}`));
  const description = [
    "Update durable state owned by Slate: memory, routines, workflows, profile, settings, connections, project membership, and avatar. Use this capability for changes; use shell tools when you need to inspect files.",
    "",
    "target + action:",
    ...operationLines,
    "",
    "Apply ordinary changes directly. A routine that may act later can require review; if review is requested, the result reports its decision.",
  ].join("\n");
  return defineCommunicateTool(deps, {
    id: "PLATFORM_ACTION", name: SLATE_UPDATE_STATE_TOOL_NAME,
    description,
    parameters: slateUpdateStateParameters,
    describeActivity: (args: SlateStateUpdate) => ({ detail: describeStateUpdate(args) }),
    execute: async (_ctx, args: SlateStateUpdate, runtime) => {
      runtime.assertNoPendingAutoReviewApproval?.();
      const outcome = await applySlateStateUpdate(args, runtime);
      return outcome.ok ? outcome.detail : `Not saved — ${outcome.reason}`;
    },
  });
}
