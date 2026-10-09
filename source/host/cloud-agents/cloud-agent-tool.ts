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
import { dumpCloudAgentTranscript } from "./cloud-agent-transcript-dump.ts";

export class SlateCloudAgentToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlateCloudAgentToolInputError";
  }
}

export const CANCELLED_BEFORE_CLOUD_AGENT_CALL = "The cloud agent action was cancelled.";
export const DESTRUCTIVE_ACTIONS = new Set(["cancel", "archive", "unarchive", "delete"]);
export const REVIEW_GATED_ACTIONS = new Set(["launch", "reply", "rename", "cancel", "archive", "unarchive", "delete"]);

export { slateQuietWorkOriginKey };

export type CloudAgentEnvironment = { type: "cloud" } | { type: "pool"; name?: string; team_id?: number } | { type: "machine"; name: string; team_id?: number } | { type: "environment"; id?: string; name?: string };

export type CloudAgentAction = "launch" | "list" | "models" | "get" | "dump" | "watch" | "reply" | "rename" | "cancel" | "archive" | "unarchive" | "delete" | "list_artifacts";

export interface CloudAgentToolArgs {
  action: CloudAgentAction;
  prompt?: string;
  images?: readonly { url: string }[];
  repo_url?: string;
  starting_ref?: string;
  model?: string;
  model_params?: Record<string, string>;
  title?: string;
  environment?: CloudAgentEnvironment;
  interrupt?: boolean;
  agent_id?: string;
  scope?: "launched" | "all";
  include_archived?: boolean;
  limit?: number;
  confirm?: boolean;
}

export interface CloudModelParam {
  id: string;
  values: readonly { value: string }[];
  incompatibleWith?: Readonly<Record<string, readonly string[]>>;
}

export interface CloudModelCatalogEntry {
  id: string;
  displayName?: string;
  aliases: readonly string[];
  params: readonly CloudModelParam[];
  incompatibilities?: readonly string[];
}

export interface CloudAgentSummary {
  bcId: string;
  name: string;
  status: string;
  isArchived: boolean;
  branchName: string;
  prUrl: string;
  url: string;
}

export interface CloudAgentDetail extends CloudAgentSummary {
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  error?: string;
}

export interface CloudAgentApi {
  launch(args: Record<string, unknown>): Promise<{ bcId: string; url: string }>;
  list(args: { limit?: number; includeArchived?: boolean }): Promise<CloudAgentSummary[]>;
  listModels(): Promise<CloudModelCatalogEntry[]>;
  get(id: string): Promise<CloudAgentDetail | null>;
  getTranscriptDump(args: { bcId: string }): Promise<{ status: string; lineCount: number; jsonl: string } | null>;
  reply(args: Record<string, unknown>): Promise<{ runId: string }>;
  rename(id: string, title: string): Promise<unknown>;
  cancel(id: string): Promise<unknown>;
  setArchived(id: string, archived: boolean): Promise<unknown>;
  delete(id: string): Promise<unknown>;
  listArtifacts(id: string): Promise<readonly { path: string; sizeBytes: number }[]>;
}

export interface CloudAgentToolContext {
  readonly signal: AbortSignal;
  get(key: typeof slateQuietWorkOriginKey): unknown;
}

export interface CloudAgentToolDeps {
  readonly api: CloudAgentApi;
  readonly launchedIds: Set<string>;
  readonly agentDir: string;
  readonly readBoxFile?: (ctx: CloudAgentToolContext, path: string) => Promise<Uint8Array>;
  readonly writeBoxFile: (ctx: CloudAgentToolContext, path: string, data: Uint8Array) => Promise<unknown>;
  readonly toolCallId?: string;
  readonly reviewAction?: (args: { args: CloudAgentToolArgs; toolCallId: string; images: readonly CloudAgentImage[]; signal?: AbortSignal }) => Promise<{ allowed: boolean; reason: string }>;
  readonly watch?: (id: string, options: { quietOrigin: unknown; afterFollowup?: boolean }) => void;
  readonly onLaunched?: (event: { bcId: string; model?: string }) => void;
  readonly onFollowupSent?: (event: { bcId: string; interrupt: boolean; model?: string }) => void;
}

/** Where a cloud agent runs, as the caller is told. */
export function cloudAgentRuntimeDescription(environment?: CloudAgentEnvironment): string {
  if (environment == null || environment.type === "cloud") return "a Slate cloud VM";
  if (environment.type === "pool") return environment.name == null ? "an eligible self-hosted pool" : `the '${environment.name}' self-hosted pool`;
  if (environment.type === "machine") return `the '${environment.name}' private worker`;
  return `a Slate cloud VM in the '${environment.name ?? environment.id}' saved environment`;
}

/** The environment as the backend names it. */
export function toCloudAgentEnvironment(environment?: CloudAgentEnvironment): unknown {
  if (environment == null) return undefined;
  if (environment.type === "cloud") return environment;
  if (environment.type === "pool" || environment.type === "machine") return { type: environment.type, name: environment.name, teamId: environment.team_id };
  return { type: "environment", publicId: environment.id, name: environment.name };
}

export function requireCloudAgentField(value: string | undefined, name: string, action: string): string {
  const trimmed = value?.trim();
  if (trimmed == null || trimmed.length === 0) throw new SlateCloudAgentToolInputError(`'${name}' is required for the '${action}' action.`);
  return trimmed;
}

function findCatalogEntry(catalog: readonly CloudModelCatalogEntry[], id: string): CloudModelCatalogEntry | undefined {
  const lower = id.toLowerCase();
  return catalog.find((entry) => entry.id.toLowerCase() === lower || entry.aliases.some((alias) => alias.toLowerCase() === lower));
}

function validateModelParams(entry: CloudModelCatalogEntry, params: Readonly<Record<string, string>>): string[] {
  const errors: string[] = [];
  for (const [id, value] of Object.entries(params)) {
    const schema = entry.params.find((candidate) => candidate.id === id);
    if (schema == null) {
      errors.push(`Unknown parameter '${id}'.`);
      continue;
    }
    if (!schema.values.some((candidate) => candidate.value === value)) {
      errors.push(`Invalid value '${value}' for '${id}' (allowed: ${schema.values.map((candidate) => candidate.value).join(", ")}).`);
    }
  }
  return errors;
}

export function modelCatalogLines(catalog: readonly CloudModelCatalogEntry[]): string[] {
  const lines: string[] = [];
  for (const entry of catalog) {
    lines.push(`- ${entry.id}${entry.displayName ? ` (${entry.displayName})` : ""}${entry.aliases.length > 0 ? ` [aliases: ${entry.aliases.join(", ")}]` : ""}`);
    for (const param of entry.params) lines.push(`    ${param.id}: ${param.values.map((value) => value.value).join(" | ")}`);
    for (const note of entry.incompatibilities ?? []) lines.push(`    (restriction) ${note}`);
  }
  return lines;
}

/**
 * Whether a model and its parameters are ones the account can launch with. A catalog that could not be read is not a
 * reason to refuse — the backend decides in that case.
 */
export async function validateModelSelection(api: Pick<CloudAgentApi, "listModels">, modelId?: string, modelParams?: Record<string, string>): Promise<string | null> {
  const id = modelId?.trim() ?? "";
  const params = modelParams != null && Object.keys(modelParams).length > 0 ? modelParams : undefined;
  if (id.length === 0) return params == null ? null : "'model' is required when 'model_params' are provided.";
  let catalog: CloudModelCatalogEntry[];
  try {
    catalog = await api.listModels();
  } catch {
    return null;
  }
  const entry = findCatalogEntry(catalog, id);
  if (entry == null) return `Unknown model '${modelId}'. Use the 'models' action to list valid models. Available: ${catalog.map((value) => value.id).join(", ")}.`;
  if (params != null) {
    const errors = validateModelParams(entry, params);
    if (errors.length > 0) return `Invalid model_params for ${entry.id}: ${errors.join(" ")}`;
  }
  return null;
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
  return `- ${summary.bcId} — ${summary.name.trim() || "(unnamed)"} [${bits.join(", ")}] ${summary.url}`;
}

/** What one action was given: the caller's words, the tool's deps, and the images loaded for it. */
interface ActionWorld {
  readonly ctx: CloudAgentToolContext;
  readonly args: CloudAgentToolArgs;
  readonly deps: CloudAgentToolDeps;
  readonly images: readonly CloudAgentImage[];
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
  let result: { bcId: string; url: string };
  try {
    result = await deps.api.launch({ prompt, repoUrl, startingRef: args.starting_ref, modelId: args.model, modelParams: args.model_params, images: world.images, title: args.title, environment: toCloudAgentEnvironment(environment) });
  } catch (error) {
    const rejection = backendRejectionMessage(error);
    if (rejection != null) return `Could not launch the cloud agent: ${rejection}`;
    throw error;
  }
  deps.launchedIds.add(result.bcId);
  deps.onLaunched?.({ bcId: result.bcId, ...(args.model ? { model: args.model } : {}) });
  deps.watch?.(result.bcId, { quietOrigin: quietOriginKey(world) });
  const followup = deps.watch
    ? 'You\'re revived automatically when it finishes, so keep working and don\'t poll it — use "reply" to send a follow-up, or "get" if you need its status sooner.'
    : 'Use action "get" with this agent_id to check status, or "reply" to send a follow-up.';
  const pullRequest = environment?.type === "machine" ? " It opens a PR when done only if the worker can push to the repo." : " It will open a PR when done.";
  return `Launched cloud agent ${result.bcId}.\n${result.url}\nIt runs on ${cloudAgentRuntimeDescription(environment)}.${pullRequest} ${followup}`;
}

async function listCloudAgents(world: ActionWorld): Promise<string> {
  const { args, deps } = world;
  const scope = args.scope ?? "launched";
  const all = await deps.api.list({ ...(args.limit === undefined ? {} : { limit: args.limit }), ...(args.include_archived === undefined ? {} : { includeArchived: args.include_archived }) });
  const listed = scope === "launched" ? all.filter((summary) => deps.launchedIds.has(summary.bcId)) : all;
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
  const lines = [`Cloud agent ${detail.bcId} — ${detail.name || "(unnamed)"}`, `Status: ${detail.status}${detail.isArchived ? " (archived)" : ""}`, `URL: ${detail.url}`];
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
    return `dump is limited to cloud agents you launched, watched, or replied to this session (not ${id}). Use action "watch" with ${id} first to manage it, or read its changes from its branch via \`gh pr diff\` / \`gh api\`.`;
  }
  const outcome = await dumpCloudAgentTranscript({ api: deps.api, writeBoxFile: (path, data) => deps.writeBoxFile(world.ctx, path, data), bcId: id });
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
    result = await deps.api.reply({ bcId: id, prompt, modelId: args.model, modelParams: args.model_params, images: world.images, interrupt });
  } catch (error) {
    const rejection = backendRejectionMessage(error);
    if (rejection != null) return `Could not send the follow-up: ${rejection}`;
    throw error;
  }
  deps.onFollowupSent?.({ bcId: id, interrupt, ...(args.model ? { model: args.model } : {}) });
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

const cloudAgentActions: Record<CloudAgentAction, (world: ActionWorld) => Promise<string>> = {
  launch: launchCloudAgent,
  list: listCloudAgents,
  models: listCloudAgentModels,
  get: readCloudAgent,
  dump: dumpCloudAgent,
  watch: watchCloudAgent,
  reply: replyToCloudAgent,
  rename: renameCloudAgent,
  cancel: cancelCloudAgent,
  archive: setCloudAgentArchived,
  unarchive: setCloudAgentArchived,
  delete: deleteCloudAgent,
  list_artifacts: listCloudAgentArtifacts,
};

/**
 * What has to be true before an action runs: a destructive one was confirmed, the images it was given loaded, and the
 * platform's review of the action allowed it. Answers either the refusal to return or the images to carry on with.
 */
async function cloudAgentPreflight(ctx: CloudAgentToolContext, args: CloudAgentToolArgs, deps: CloudAgentToolDeps): Promise<{ images: readonly CloudAgentImage[] } | { refusal: string }> {
  if (DESTRUCTIVE_ACTIONS.has(args.action) && args.confirm !== true) {
    return { refusal: `'${args.action}' is destructive. Confirm with the user first (e.g. a SendMessage widget), then call CloudAgent again with confirm: true.` };
  }
  let images: readonly CloudAgentImage[] = [];
  if (args.action === "launch" || args.action === "reply") {
    const loaded = await loadCloudAgentImages({ ctx, urls: (args.images ?? []).map((image) => image.url), agentDir: deps.agentDir, ...(deps.readBoxFile === undefined ? {} : { readBoxFile: deps.readBoxFile }) });
    if (!loaded.ok) return { refusal: `${args.action === "launch" ? "Could not launch the cloud agent" : "Could not send the follow-up"}: ${loaded.message}` };
    images = loaded.images;
  }
  if (deps.reviewAction != null && REVIEW_GATED_ACTIONS.has(args.action)) {
    const review = await deps.reviewAction({ args, toolCallId: deps.toolCallId ?? "cloud-agent", images, signal: ctx.signal });
    if (!review.allowed) return { refusal: review.reason };
  }
  return { images };
}

export async function runCloudAgentAction(ctx: CloudAgentToolContext, args: CloudAgentToolArgs, deps: CloudAgentToolDeps): Promise<string> {
  const preflight = await cloudAgentPreflight(ctx, args, deps);
  if ("refusal" in preflight) return preflight.refusal;
  return await cloudAgentActions[args.action]({ ctx, args, deps, images: preflight.images });
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
