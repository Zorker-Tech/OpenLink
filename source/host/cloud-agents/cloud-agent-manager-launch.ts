import { randomUUID } from "node:crypto";
import { SlateCloudAgentLaunchError } from "./cloud-agent-launch-error.ts";
import {
  buildCloudAgentConversationAction,
  buildCloudAgentRequestedModel,
  buildCloudAgentUserMessage,
  buildRepoFromRemote,
  resolveCloudAgentEnvironmentFields,
  resolveLaunchRepoReference,
  toStartRepoConfig,
  type CloudAgentEnvironment,
  type SavedEnvironment,
} from "./cloud-agent-request-composition.ts";
import { resolveSavedEnvironment } from "./cloud-agent-poll-loop.ts";
import type { CloudAgentClient, DashboardClient } from "./cloud-agent-manager-contracts.ts";
import { CLOUD_AGENT_REQUEST_SOURCE } from "./cloud-agent-manager-contracts.ts";
import { cloudAgentUrl } from "./cloud-agent-view-mappers.ts";

type WireRequest = Record<string, unknown>;

export interface CloudAgentLaunchRequest {
  readonly prompt: string;
  readonly repoUrl?: string;
  readonly startingRef?: string;
  readonly environment?: CloudAgentEnvironment;
  readonly modelId?: string;
  readonly modelParams?: Readonly<Record<string, string>>;
  readonly images?: readonly { readonly data: Uint8Array; readonly path?: string; readonly mimeType?: string }[];
  readonly title?: string;
}

export async function resolvePrivateWorkerTeamId(
  environment: CloudAgentEnvironment | undefined,
  getDashboardClient: () => DashboardClient,
): Promise<number | undefined> {
  if (environment == null || environment.type === "cloud" || environment.type === "environment") return undefined;
  if (environment.teamId != null) return environment.teamId;

  const activeTeams = (await getDashboardClient().getTeams({ activeOnly: true })).teams
    .filter((team) => team.id > 0 && team.isDirectMember);
  if (activeTeams.length === 1) return activeTeams[0]?.id;
  if (activeTeams.length === 0) {
    if (environment.type === "pool") {
      throw new SlateCloudAgentLaunchError("A self-hosted pool requires an active team, but this account has none.");
    }
    return undefined;
  }
  const choices = activeTeams.map((team) => `${team.name} (${team.id})`).join(", ");
  throw new SlateCloudAgentLaunchError(
    `This account has multiple active teams. Set environment.team_id to one of: ${choices}.`,
  );
}

export async function launchCloudAgent(
  client: CloudAgentClient,
  getDashboardClient: () => DashboardClient,
  args: CloudAgentLaunchRequest,
): Promise<{ readonly agentId: string; readonly url: string }> {
  if (args.environment?.type === "machine" && args.startingRef?.trim()) {
    throw new SlateCloudAgentLaunchError(
      `A named private worker runs on its own checkout, so it can't start from '${args.startingRef}'. Omit starting_ref (the worker uses its current branch), or use a cloud or pool environment to start from a specific ref.`,
    );
  }

  const saved = args.environment?.type === "environment"
    ? await resolveSavedEnvironment(client, {
      ...(args.environment.publicId === undefined ? {} : { publicId: args.environment.publicId }),
      ...(args.environment.name === undefined ? {} : { name: args.environment.name }),
    }) as SavedEnvironment
    : undefined;
  const repository = buildRepoFromRemote(resolveLaunchRepoReference(args.repoUrl, saved), args.startingRef);
  const requestedModel = buildCloudAgentRequestedModel(args.modelId, args.modelParams);
  const requestedAgentId = `bc-${randomUUID()}`;
  const teamId = await resolvePrivateWorkerTeamId(args.environment, getDashboardClient);
  const request: WireRequest = {
    agentId: requestedAgentId,
    snapshotNameOrId: repository.sanitizedRepoUrl,
    devcontainerStartingPoint: {
      url: repository.httpRepoUrl,
      ref: repository.baseBranch ?? "",
      ...(saved == null ? {} : {
        environmentPublicId: saved.publicId,
        ...(saved.name.trim() ? { environmentName: saved.name.trim() } : {}),
        repoConfig: toStartRepoConfig(saved.repoConfig),
      }),
    },
    snapshotWorkspaceRootPath: "/workspace",
    returnImmediately: true,
    repoUrl: repository.httpRepoUrl,
    source: CLOUD_AGENT_REQUEST_SOURCE,
    autoBranch: true,
    ...(repository.baseBranch === undefined ? {} : { baseBranch: repository.baseBranch }),
    autoCreatePr: true,
    conversationAction: buildCloudAgentConversationAction(buildCloudAgentUserMessage({
      prompt: args.prompt,
      mode: "agent",
      ...(args.images === undefined ? {} : { images: args.images }),
    })),
    startingMessageType: "user-message",
    addInitialMessageToResponses: true,
    repositoryInfo: { pathEncryptionKey: "", shouldSyncIndex: false },
    ...resolveCloudAgentEnvironmentFields(repository.httpRepoUrl, args.environment),
    requestedModels: requestedModel == null ? [] : [requestedModel],
    skills: [],
    ...(teamId === undefined ? {} : { teamId }),
    ...(args.title?.trim() ? { name: args.title.trim() } : {}),
  };

  const response = await client.launch(request);
  const id = response.agent?.agentId || requestedAgentId;
  return { agentId: id, url: cloudAgentUrl(id) };
}
