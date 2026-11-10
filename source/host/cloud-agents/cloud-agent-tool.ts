/**
 * The tool that launches and watches a cloud agent.
 *
 * Every action reads the same way: what must be confirmed first, what the images the caller gave became, whether the
 * platform reviews this action, and then the action itself. A launch is quiet work — marked so the reader is not told
 * about it — its full transcript is dumped into the box for the agent's own tools to read, and a cloud agent this
 * session started, watched or replied to is remembered, because that is what "list" and "dump" are allowed to see.
 */

import { slateQuietWorkOriginKey } from "../slate-quiet-work-origin.ts";
import { loadCloudAgentImages, type CloudAgentImage } from "./cloud-agent-images.ts";
import { modelCatalogLines, validateModelSelection } from "./cloud-agent-model-catalog.ts";
import { dumpCloudAgentTranscript } from "./cloud-agent-transcript-dump.ts";
import type {
  CloudAgentAction,
  CloudAgentApi,
  CloudAgentDetail,
  CloudAgentEnvironment,
  CloudAgentLaunchRequest,
  CloudAgentReplyRequest,
  CloudAgentRuntimeEnvironment,
  CloudAgentSummary,
  CloudAgentToolArgs,
  CloudAgentToolContext,
  CloudAgentToolDeps,
  CloudModelCatalogEntry,
} from "./cloud-agent-tool-contracts.ts";

export type {
  CloudAgentAction,
  CloudAgentApi,
  CloudAgentDetail,
  CloudAgentEnvironment,
  CloudAgentLaunchRequest,
  CloudAgentReplyRequest,
  CloudAgentRuntimeEnvironment,
  CloudAgentSummary,
  CloudAgentToolArgs,
  CloudAgentToolContext,
  CloudAgentToolDeps,
  CloudModelCatalogEntry,
  CloudModelParam,
} from "./cloud-agent-tool-contracts.ts";
export { modelCatalogLines, validateModelSelection } from "./cloud-agent-model-catalog.ts";

export class SlateCloudAgentToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlateCloudAgentToolInputError";
  }
}

export const CANCELLED_BEFORE_CLOUD_AGENT_CALL = "The cloud agent action was cancelled.";

export { slateQuietWorkOriginKey };

/** Where a cloud agent runs, as the caller is told. */
export function cloudAgentRuntimeDescription(environment?: CloudAgentEnvironment): string {
  if (environment == null || environment.type === "cloud") return "a Slate cloud VM";
  if (environment.type === "pool") return environment.name == null ? "an eligible self-hosted pool" : `the '${environment.name}' self-hosted pool`;
  if (environment.type === "machine") return `the '${environment.name}' private worker`;
  return `a Slate cloud VM in the '${environment.name ?? environment.id}' saved environment`;
}

/** The environment as the backend names it. */
export function toCloudAgentEnvironment(environment?: CloudAgentEnvironment): CloudAgentRuntimeEnvironment | undefined {
  if (environment == null) return undefined;
  if (environment.type === "cloud") return { type: "cloud" };
  if (environment.type === "pool" || environment.type === "machine") {
    return { type: environment.type, name: environment.name, teamId: environment.team_id };
  }
  return { type: "environment", publicId: environment.id, name: environment.name };
}

export function requireCloudAgentField(value: string | undefined, name: string, action: string): string {
  const trimmed = value?.trim();
  if (trimmed == null || trimmed.length === 0) throw new SlateCloudAgentToolInputError(`'${name}' is required for the '${action}' action.`);
  return trimmed;
}

/** What the backend said when it refused, when it said anything a caller can read. */
export function backendRejectionMessage(error: unknown): string | null {
  if (typeof error !== "object" || error == null) return null;
  const candidate = error as { detail?: unknown; details?: unknown; message?: unknown };
  const direct = typeof candidate.detail === "string" ? candidate.detail.trim() : "";
  if (direct.length > 0) return direct;
  if (Array.isArray(candidate.details)) {
    const detail = candidate.details.find((value) => typeof value === "object" && value != null && "detail" in value) as { detail?: unknown } | undefined;
    if (typeof detail?.detail === "string" && detail.detail.trim().length > 0) return detail.detail.trim();
  }
  return null;
}

export function summaryLine(summary: CloudAgentSummary): string {
  const bits = [summary.status];
  if (summary.isArchived) bits.push("archived");
  if (summary.branchName.length > 0) bits.push(summary.branchName);
  if (summary.prUrl.length > 0) bits.push(summary.prUrl);
  return `- ${summary.agentId} — ${summary.name.trim() || "(unnamed)"} [${bits.join(", ")}] ${summary.url}`;
}

/** What one action was given: the caller's words, the tool's deps, and the images loaded for it. */
interface ActionWorld {
  readonly ctx: CloudAgentToolContext;
  readonly args: CloudAgentToolArgs;
  readonly deps: CloudAgentToolDeps;
  readonly images: readonly CloudAgentImage[];
}

interface CloudAgentActionPolicy {
  readonly confirmDestructive: boolean;
  readonly review: boolean;
  readonly loadImages: boolean;
  readonly execute: (world: ActionWorld) => Promise<string>;
}

const quietOriginKey = (world: ActionWorld): unknown => world.ctx.get(slateQuietWorkOriginKey);

async function launchCloudAgent(world: ActionWorld): Promise<string> {
  const { args, deps } = world;
  const prompt = requireCloudAgentField(args.prompt, "prompt", "launch");
  const environment = args.environment;
  if (environment?.type === "environment" && environment.id == null && environment.name == null) {
    return "A saved-environment launch needs environment.name (the environment's display name) or environment.id (its public id).";
  }
  // A saved environment already names its repository; every other kind is launched against one the caller gave.
  const repoUrl = environment?.type === "environment" ? args.repo_url?.trim() || undefined : requireCloudAgentField(args.repo_url, "repo_url", "launch");
  const modelError = await validateModelSelection(deps.api, args.model, args.model_params);
  if (modelError != null) return modelError;
  if (world.ctx.signal.aborted) return CANCELLED_BEFORE_CLOUD_AGENT_CALL;
  let result: { agentId: string; url: string };
  try {
    result = await deps.api.launch({ prompt, repoUrl, startingRef: args.starting_ref, modelId: args.model, modelParams: args.model_params, images: world.images, title: args.title, environment: toCloudAgentEnvironment(environment) });
  } catch (error) {
    const rejection = backendRejectionMessage(error);
    if (rejection != null) return `Could not launch the cloud agent: ${rejection}`;
    throw error;
  }
  deps.launchedIds.add(result.agentId);
  deps.onLaunched?.({ agentId: result.agentId, ...(args.model ? { model: args.model } : {}) });
  deps.watch?.(result.agentId, { quietOrigin: quietOriginKey(world) });
  const followup = deps.watch
    ? 'You\'re revived automatically when it finishes, so keep working and don\'t poll it — use "reply" to send a follow-up, or "get" if you need its status sooner.'
    : 'Use action "get" with this agent_id to check status, or "reply" to send a follow-up.';
  const pullRequest = environment?.type === "machine" ? " It opens a PR when done only if the worker can push to the repo." : " It will open a PR when done.";
  return `Launched cloud agent ${result.agentId}.\n${result.url}\nIt runs on ${cloudAgentRuntimeDescription(environment)}.${pullRequest} ${followup}`;
}

async function listCloudAgents(world: ActionWorld): Promise<string> {
  const { args, deps } = world;
  const scope = args.scope ?? "launched";
  const all = await deps.api.list({ ...(args.limit === undefined ? {} : { limit: args.limit }), ...(args.include_archived === undefined ? {} : { includeArchived: args.include_archived }) });
  const listed = scope === "launched" ? all.filter((summary) => deps.launchedIds.has(summary.agentId)) : all;
  if (listed.length === 0) {
    return scope === "launched" ? 'No cloud agents launched via this tool yet. Use scope: "all" to list every cloud agent on the account.' : "No cloud agents found.";
  }
  const heading = scope === "launched" ? `Cloud agents launched via this tool (${listed.length}):` : `Cloud agents on the account (${listed.length}):`;
  return [heading, ...listed.map(summaryLine)].join("\n");
}

async function listCloudAgentModels(world: ActionWorld): Promise<string> {
  const catalog = await world.deps.api.listModels();
  return catalog.length === 0 ? "No models available." : [`Available cloud-agent models (${catalog.length}). Pass 'model' (id) and optional 'model_params' (param id → value) to launch/reply:`, ...modelCatalogLines(catalog)].join("\n");
}

async function readCloudAgent(world: ActionWorld): Promise<string> {
  const id = requireCloudAgentField(world.args.agent_id, "agent_id", "get");
  const detail = await world.deps.api.get(id);
  if (detail == null) return `No cloud agent found for ${id}.`;
  const lines = [`Cloud agent ${detail.agentId} — ${detail.name || "(unnamed)"}`, `Status: ${detail.status}${detail.isArchived ? " (archived)" : ""}`, `URL: ${detail.url}`];
  if (detail.branchName) lines.push(`Branch: ${detail.branchName}`);
  if (detail.prUrl) lines.push(`Pull request: ${detail.prUrl}`);
  if (detail.filesChanged > 0) lines.push(`Changes: +${detail.linesAdded}/-${detail.linesRemoved} across ${detail.filesChanged} file(s).`);
  if (detail.error != null) lines.push(detail.error);
  return lines.join("\n");
}

async function dumpCloudAgent(world: ActionWorld): Promise<string> {
  const { args, deps } = world;
  const id = requireCloudAgentField(args.agent_id, "agent_id", "dump");
  // Only agents this session is already following may be dumped: an id from nowhere is not one to read.
  if (!deps.launchedIds.has(id)) {
    return `dump is limited to agents this session has launched, watched, or replied to (not ${id}). Use action "watch" with ${id} first, or inspect the branch with your available repository tools.`;
  }
  const outcome = await dumpCloudAgentTranscript({ api: deps.api, writeBoxFile: (path, data) => deps.writeBoxFile(world.ctx, path, data), agentId: id });
  if (outcome == null) return `No cloud agent found for ${id}.`;
  const progress =
    outcome.status === "running" || outcome.status === "creating"
      ? "The run is still in progress, so this is the transcript so far."
      : outcome.status === "finished"
        ? "The run has finished, so this is the complete transcript."
        : `The run has ended (${outcome.status}), so this is the transcript as left.`;
  if (outcome.file == null) return `Cloud agent ${id} hasn't produced any transcript output yet. ${progress}`;
  return [
    `Wrote ${id}'s full transcript to ${outcome.file.path} (${outcome.file.sizeBytes} bytes, ${outcome.lineCount} message lines).`,
    progress,
    "Format: JSONL, one JSON message per line — role, text, reasoning/thinking, tool calls with args, and tool results. Use Shell to grep it or Read to read it.",
    `For just the final report, read the last line: \`tail -n 1 ${outcome.file.path}\` (the final assistant message).`,
  ].join("\n");
}

async function watchCloudAgent(world: ActionWorld): Promise<string> {
  const { args, deps } = world;
  const id = requireCloudAgentField(args.agent_id, "agent_id", "watch");
  if (deps.watch == null) return `Watching isn't available here. Use action "get" with ${id} to check its status.`;
  deps.watch(id, { quietOrigin: quietOriginKey(world) });
  deps.launchedIds.add(id);
  return `Watching ${id}. You'll be revived automatically when it finishes — keep working and don't poll it.`;
}

async function replyToCloudAgent(world: ActionWorld): Promise<string> {
  const { args, deps } = world;
  const id = requireCloudAgentField(args.agent_id, "agent_id", "reply");
  const prompt = requireCloudAgentField(args.prompt, "prompt", "reply");
  const modelError = await validateModelSelection(deps.api, args.model, args.model_params);
  if (modelError != null) return modelError;
  const interrupt = args.interrupt ?? false;
  // Whether there was anything to interrupt decides what the caller is told, not what is sent.
  let wasRunning = false;
  if (interrupt) {
    try {
      const detail = await deps.api.get(id);
      wasRunning = detail?.status === "running" || detail?.status === "creating";
    } catch {}
  }
  if (world.ctx.signal.aborted) return CANCELLED_BEFORE_CLOUD_AGENT_CALL;
  let result: { runId: string };
  try {
    result = await deps.api.reply({ agentId: id, prompt, modelId: args.model, modelParams: args.model_params, images: world.images, interrupt });
  } catch (error) {
    const rejection = backendRejectionMessage(error);
    if (rejection != null) return `Could not send the follow-up: ${rejection}`;
    throw error;
  }
  deps.onFollowupSent?.({ agentId: id, interrupt, ...(args.model ? { model: args.model } : {}) });
  deps.watch?.(id, { afterFollowup: true, quietOrigin: quietOriginKey(world) });
  deps.launchedIds.add(id);
  const sent = !interrupt
    ? `Sent follow-up to ${id} (run ${result.runId})`
    : wasRunning
      ? `Interrupted ${id}'s active run and delivered the follow-up immediately (run ${result.runId}); it starts processing now`
      : `Sent follow-up to ${id} (run ${result.runId}); it wasn't running, so there was nothing to interrupt and it starts a fresh run`;
  return `${sent}. ${deps.watch ? "You're revived automatically when this follow-up finishes, so keep working and don't poll it." : 'Use "get" to check status.'}`;
}

async function renameCloudAgent(world: ActionWorld): Promise<string> {
  const id = requireCloudAgentField(world.args.agent_id, "agent_id", "rename");
  const title = requireCloudAgentField(world.args.title, "title", "rename");
  try {
    await world.deps.api.rename(id, title);
  } catch (error) {
    const rejection = backendRejectionMessage(error);
    if (rejection != null) return `Could not rename the cloud agent: ${rejection}`;
    throw error;
  }
  return `Renamed ${id} to "${title}". The new title shows everywhere the agent appears (across Slate, the IDE sidebar and mobile).`;
}

async function cancelCloudAgent(world: ActionWorld): Promise<string> {
  const id = requireCloudAgentField(world.args.agent_id, "agent_id", "cancel");
  await world.deps.api.cancel(id);
  return `Requested cancellation of the active run for ${id}.`;
}

async function setCloudAgentArchived(world: ActionWorld): Promise<string> {
  const id = requireCloudAgentField(world.args.agent_id, "agent_id", world.args.action);
  await world.deps.api.setArchived(id, world.args.action === "archive");
  return `${world.args.action === "archive" ? "Archived" : "Unarchived"} ${id}.`;
}

async function deleteCloudAgent(world: ActionWorld): Promise<string> {
  const id = requireCloudAgentField(world.args.agent_id, "agent_id", "delete");
  await world.deps.api.delete(id);
  world.deps.launchedIds.delete(id);
  return `Permanently deleted ${id}.`;
}

async function listCloudAgentArtifacts(world: ActionWorld): Promise<string> {
  const id = requireCloudAgentField(world.args.agent_id, "agent_id", "list_artifacts");
  const artifacts = await world.deps.api.listArtifacts(id);
  return artifacts.length === 0 ? `No artifacts for ${id}.` : [`Artifacts for ${id} (${artifacts.length}):`, ...artifacts.map((artifact) => `- ${artifact.path} (${artifact.sizeBytes} bytes)`)].join("\n");
}

const cloudAgentActions: Record<CloudAgentAction, CloudAgentActionPolicy> = {
  launch: { confirmDestructive: false, review: true, loadImages: true, execute: launchCloudAgent },
  list: { confirmDestructive: false, review: false, loadImages: false, execute: listCloudAgents },
  models: { confirmDestructive: false, review: false, loadImages: false, execute: listCloudAgentModels },
  get: { confirmDestructive: false, review: false, loadImages: false, execute: readCloudAgent },
  dump: { confirmDestructive: false, review: false, loadImages: false, execute: dumpCloudAgent },
  watch: { confirmDestructive: false, review: false, loadImages: false, execute: watchCloudAgent },
  reply: { confirmDestructive: false, review: true, loadImages: true, execute: replyToCloudAgent },
  rename: { confirmDestructive: false, review: true, loadImages: false, execute: renameCloudAgent },
  cancel: { confirmDestructive: true, review: true, loadImages: false, execute: cancelCloudAgent },
  archive: { confirmDestructive: true, review: true, loadImages: false, execute: setCloudAgentArchived },
  unarchive: { confirmDestructive: true, review: true, loadImages: false, execute: setCloudAgentArchived },
  delete: { confirmDestructive: true, review: true, loadImages: false, execute: deleteCloudAgent },
  list_artifacts: { confirmDestructive: false, review: false, loadImages: false, execute: listCloudAgentArtifacts },
};

const cloudAgentActionNames = Object.keys(cloudAgentActions) as CloudAgentAction[];
export const DESTRUCTIVE_ACTIONS = new Set(
  cloudAgentActionNames.filter((action) => cloudAgentActions[action].confirmDestructive),
);
export const REVIEW_GATED_ACTIONS = new Set(
  cloudAgentActionNames.filter((action) => cloudAgentActions[action].review),
);

/**
 * What has to be true before an action runs: a destructive one was confirmed, the images it was given loaded, and the
 * platform's review of the action allowed it. Answers either the refusal to return or the images to carry on with.
 */
async function cloudAgentPreflight(ctx: CloudAgentToolContext, args: CloudAgentToolArgs, deps: CloudAgentToolDeps): Promise<{ images: readonly CloudAgentImage[] } | { refusal: string }> {
  const policy = cloudAgentActions[args.action];
  if (policy.confirmDestructive && args.confirm !== true) {
    return { refusal: `'${args.action}' is destructive. Confirm with the user first (e.g. a SendMessage widget), then call CloudAgent again with confirm: true.` };
  }
  let images: readonly CloudAgentImage[] = [];
  if (policy.loadImages) {
    const loaded = await loadCloudAgentImages({ ctx, urls: (args.images ?? []).map((image) => image.url), agentDir: deps.agentDir, ...(deps.readBoxFile === undefined ? {} : { readBoxFile: deps.readBoxFile }) });
    if (!loaded.ok) return { refusal: `${args.action === "launch" ? "Could not launch the cloud agent" : "Could not send the follow-up"}: ${loaded.message}` };
    images = loaded.images;
  }
  if (deps.reviewAction != null && policy.review) {
    const review = await deps.reviewAction({ args, toolCallId: deps.toolCallId ?? "cloud-agent", images, signal: ctx.signal });
    if (!review.allowed) return { refusal: review.reason };
  }
  return { images };
}

export async function runCloudAgentAction(ctx: CloudAgentToolContext, args: CloudAgentToolArgs, deps: CloudAgentToolDeps): Promise<string> {
  const preflight = await cloudAgentPreflight(ctx, args, deps);
  if ("refusal" in preflight) return preflight.refusal;
  return await cloudAgentActions[args.action].execute({ ctx, args, deps, images: preflight.images });
}

/** The repository a url points at, as a tool activity line shows it. */
export function repoShortName(repoUrl?: string): string | undefined {
  if (!repoUrl) return undefined;
  try {
    const last = new URL(repoUrl).pathname.split("/").filter(Boolean).at(-1);
    return last?.endsWith(".git") ? last.slice(0, -4) : last;
  } catch {
    return undefined;
  }
}

export function createCloudAgentTool(deps: CloudAgentToolDeps) {
  return {
    id: "CLOUD_AGENT",
    toolIdentifier: "CLOUD_AGENT",
    name: "CloudAgent",
    description: "Manage Slate cloud agents: launch, list, inspect, watch, follow up, and manage their lifecycle.",
    describeActivity: (args: CloudAgentToolArgs) => {
      const repo = repoShortName(args.repo_url);
      return repo == null ? undefined : { detail: repo };
    },
    execute: (ctx: CloudAgentToolContext, args: CloudAgentToolArgs) => runCloudAgentAction(ctx, args, deps),
  };
}
