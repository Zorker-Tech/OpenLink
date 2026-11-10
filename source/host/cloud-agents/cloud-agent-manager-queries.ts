import {
  buildCloudAgentConversationAction,
  buildCloudAgentRequestedModel,
  buildCloudAgentUserMessage,
} from "./cloud-agent-request-composition.ts";
import { resolveSlateLimitError } from "./cloud-agent-poll-loop.ts";
import type { CloudAgentClient } from "./cloud-agent-manager-contracts.ts";
import {
  buildTranscriptJsonl,
  cloudAgentUrl,
  mapRunStatus,
  resolveBranchName,
  resolvePr,
  resolvePrUrl,
  toFileChange,
} from "./cloud-agent-view-mappers.ts";
import { CLOUD_AGENT_REQUEST_SOURCE, MAX_CLOUD_AGENT_FILES } from "./cloud-agent-manager-contracts.ts";

const DEFAULT_LIST_LIMIT = 20;

export async function listCloudAgents(
  client: CloudAgentClient,
  options?: { readonly limit?: number; readonly includeArchived?: boolean },
) {
  const response = await client.listBackgroundComposers({ n: options?.limit ?? DEFAULT_LIST_LIMIT });
  return response.composers
    .filter((item) => options?.includeArchived === true || item.isArchived !== true)
    .map((item) => {
      const id = String(item.bcId ?? "");
      return {
        agentId: id,
        name: String(item.name ?? ""),
        status: mapRunStatus(item.status),
        branchName: String(item.branchName ?? ""),
        prUrl: String(item.prUrl ?? ""),
        isArchived: item.isArchived === true,
        createdAtMs: Number(item.createdAtMs ?? 0),
        url: cloudAgentUrl(id),
      };
    });
}

export async function getCloudAgent(client: CloudAgentClient, rawId: string) {
  const id = rawId.trim();
  if (id.length === 0) return null;
  const detailed = (await client.getBackgroundComposerInfo({
    bcId: id,
    includeDiff: false,
    doNotThrowIfSetupNotFinished: true,
  })).composer;
  const run = detailed?.composer;
  if (run == null) return null;

  return {
    agentId: id,
    name: run.name ?? "",
    status: mapRunStatus(run.status),
    branchName: resolveBranchName(detailed),
    prUrl: resolvePrUrl(detailed),
    isArchived: run.isArchived ?? false,
    createdAtMs: run.createdAtMs ?? 0,
    url: cloudAgentUrl(id),
    filesChanged: run.filesChanged ?? 0,
    linesAdded: run.linesAdded ?? 0,
    linesRemoved: run.linesRemoved ?? 0,
    error: resolveSlateLimitError(detailed),
  };
}

export async function replyToCloudAgent(
  client: CloudAgentClient,
  args: {
    readonly agentId: string;
    readonly prompt: string;
    readonly images?: readonly { readonly data: Uint8Array; readonly path?: string; readonly mimeType?: string }[];
    readonly interrupt?: boolean;
    readonly modelId?: string;
    readonly modelParams?: Readonly<Record<string, string>>;
  },
): Promise<{ readonly runId: string | undefined }> {
  const requestedModel = buildCloudAgentRequestedModel(args.modelId, args.modelParams);
  const response = await client.addAsyncFollowupBackgroundComposer({
    bcId: args.agentId,
    followupConversationAction: buildCloudAgentConversationAction(buildCloudAgentUserMessage({
      prompt: args.prompt,
      ...(args.images === undefined ? {} : { images: args.images }),
    })),
    synchronous: args.interrupt ?? false,
    followupSource: CLOUD_AGENT_REQUEST_SOURCE,
    ...(requestedModel == null ? {} : { requestedModel }),
  });
  return { runId: response.runId };
}

export async function pauseCloudAgent(client: CloudAgentClient, agentId: string): Promise<void> {
  await client.pauseBackgroundComposer({ bcId: agentId, source: CLOUD_AGENT_REQUEST_SOURCE });
}

export async function renameCloudAgent(client: CloudAgentClient, agentId: string, name: string): Promise<void> {
  await client.renameBackgroundComposer({ bcId: agentId, newName: name });
}

export async function setCloudAgentArchived(client: CloudAgentClient, agentId: string, archived: boolean): Promise<void> {
  await client.archiveBackgroundComposer({ bcId: agentId, unarchive: !archived, source: CLOUD_AGENT_REQUEST_SOURCE });
}

export async function deleteCloudAgent(client: CloudAgentClient, agentId: string): Promise<void> {
  await client.deleteBackgroundComposer({ bcId: agentId });
}

export async function listCloudAgentArtifacts(client: CloudAgentClient, agentId: string) {
  const response = await client.listBackgroundComposerArtifacts({ bcId: agentId });
  return response.artifacts.map((artifact) => ({ path: artifact.absolutePath, sizeBytes: Number(artifact.sizeBytes) }));
}

export async function getCloudAgentTranscriptDump(
  client: CloudAgentClient,
  convertConversation: (conversation: unknown) => readonly unknown[],
  rawId: string,
) {
  const agentId = rawId.trim();
  if (agentId.length === 0) return null;

  const conversation = await client.getBackgroundComposerConversation({ bcId: agentId });
  const dump = buildTranscriptJsonl(conversation.conversation, convertConversation);
  let status = "unknown";
  try {
    const response = await client.getBackgroundComposerInfo({
      bcId: agentId,
      includeDiff: false,
      doNotThrowIfSetupNotFinished: true,
    });
    status = mapRunStatus(response.composer?.composer?.status);
  } catch {
    // The transcript can still be read when status lookup is unavailable.
  }
  return { ...dump, status };
}

export async function getCloudAgentInfo(
  client: CloudAgentClient,
  agentId: string,
  includeFiles: boolean,
) {
  const id = agentId.trim();
  if (id.length === 0) return null;

  let response: Awaited<ReturnType<CloudAgentClient["getBackgroundComposerInfo"]>>;
  try {
    response = await client.getBackgroundComposerInfo({
      bcId: id,
      includeDiff: false,
      doNotThrowIfSetupNotFinished: true,
    });
  } catch (error) {
    const candidate = error as { name?: unknown; code?: unknown };
    if (candidate?.name === "ConnectError" && (candidate.code === 5 || candidate.code === 7)) return null;
    throw error;
  }

  const detailed = response.composer;
  const composer = detailed?.composer;
  const filesChanged = composer?.filesChanged ?? 0;
  const pullRequest = resolvePr(detailed);
  const prUrl = resolvePrUrl(detailed);
  const [files, livePrState] = await Promise.all([
    includeFiles && filesChanged > 0 ? fetchCloudAgentFileChanges(client, id) : Promise.resolve([]),
    fetchCloudAgentLivePrState(client, prUrl, pullRequest.state),
  ]);

  return {
    agentId: id,
    status: mapRunStatus(composer?.status),
    name: composer?.name ?? "",
    prompt: detailed?.prompt?.text ?? "",
    branchName: resolveBranchName(detailed),
    prUrl,
    prState: livePrState ?? pullRequest.state,
    prNumber: pullRequest.number,
    filesChanged,
    linesAdded: composer?.linesAdded ?? 0,
    linesRemoved: composer?.linesRemoved ?? 0,
    files,
  };
}

export async function fetchCloudAgentLivePrState(
  client: CloudAgentClient,
  prUrl: string,
  savedState: string,
): Promise<string | null> {
  if (prUrl.length === 0 || savedState === "merged") return null;
  try {
    const state = await client.getPullRequestMergeStatus({ prUrl });
    if (state.isMerged) return "merged";
    if (state.isClosed) return "closed";
    if (state.isDraft) return "draft";
    return state.state === "open" ? "open" : null;
  } catch {
    return null;
  }
}

export async function fetchCloudAgentFileChanges(client: CloudAgentClient, agentId: string) {
  try {
    const response = await client.getOptimizedDiffDetails({ bcId: agentId, excludeBeforeAfterDiffs: true });
    const files: { path: string; added: number; removed: number }[] = [];
    for (const diff of response.diff?.diffs ?? []) {
      const file = toFileChange(diff);
      if (file != null) files.push(file);
      if (files.length >= MAX_CLOUD_AGENT_FILES) break;
    }
    return files;
  } catch {
    return [];
  }
}
