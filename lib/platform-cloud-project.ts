import type { createOpenLinkCloudSdk } from "./platform-cloud-sdk";

export type CloudProjectLink = {
  project_id: string;
  platform_project_ref: string;
  revision: number;
  updated_by: string | null;
  updated_at: string;
};
export type CloudProjectLinkReply = {
  outcome: string;
  project?: { id: string; status: string };
  link?: CloudProjectLink | null;
  can_manage?: boolean;
};
export type CloudProjectLinkCommand = (
  operation: "get" | "set" | "remove",
  projectId: string,
  platformRef?: string,
  revision?: number,
) => Promise<CloudProjectLinkReply>;
export class CloudProjectLinkError extends Error {
  readonly status: number;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
  }
}
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function identifier(value: string) {
  if (!uuid.test(value))
    throw new CloudProjectLinkError(400, "INVALID_CLOUD_REFERENCE");
  return value.toLowerCase();
}
export function createCloudProjectLinks(options: {
  mode: "local" | "cloud";
  userId: string;
  command: CloudProjectLinkCommand;
  connection: (id: string) => Promise<{
    sdk: ReturnType<typeof createOpenLinkCloudSdk>;
    state: string;
  }>;
}) {
  if (options.mode !== "cloud")
    throw new CloudProjectLinkError(404, "CLOUD_PROJECT_UNAVAILABLE");
  if (!uuid.test(options.userId))
    throw new CloudProjectLinkError(401, "INVALID_APPLICATION_IDENTITY");
  function link(value: CloudProjectLink | null | undefined, projectId: string) {
    if (value == null) return null;
    if (
      value.project_id !== projectId ||
      !uuid.test(value.platform_project_ref) ||
      !Number.isSafeInteger(value.revision) ||
      value.revision < 1
    )
      throw new CloudProjectLinkError(503, "CLOUD_PROJECT_STORAGE_UNAVAILABLE");
    return {
      project_id: value.project_id,
      platform_project_ref: value.platform_project_ref,
      revision: value.revision,
      updated_by: value.updated_by,
      updated_at: value.updated_at,
    };
  }
  async function read(projectId: string) {
    if (!uuid.test(projectId))
      throw new CloudProjectLinkError(400, "INVALID_PROJECT_ID");
    projectId = projectId.toLowerCase();
    const result = await options.command("get", projectId);
    if (result.outcome === "missing")
      throw new CloudProjectLinkError(404, "PROJECT_NOT_FOUND");
    if (
      result.outcome !== "loaded" ||
      result.project?.id !== projectId ||
      typeof result.can_manage !== "boolean"
    )
      throw new CloudProjectLinkError(503, "CLOUD_PROJECT_STORAGE_UNAVAILABLE");
    return { ...result, link: link(result.link, projectId) };
  }
  async function remote(connectionId: string, platformRef: string) {
    if (!uuid.test(connectionId) || !uuid.test(platformRef))
      throw new CloudProjectLinkError(400, "INVALID_CLOUD_REFERENCE");
    connectionId = connectionId.toLowerCase();
    platformRef = platformRef.toLowerCase();
    const { sdk, state } = await options.connection(connectionId);
    if (!["active", "refreshing"].includes(state))
      throw new CloudProjectLinkError(409, "CLOUD_CONNECTION_INACTIVE");
    const project = (await sdk.listProjects()).find(
      (value) => value.id.toLowerCase() === platformRef,
    );
    if (!project)
      throw new CloudProjectLinkError(403, "CLOUD_PROJECT_NOT_ACCESSIBLE");
    return { sdk, project };
  }
  function eligible(value: Awaited<ReturnType<typeof read>>) {
    if (value.project!.status === "archived")
      throw new CloudProjectLinkError(409, "PROJECT_ARCHIVED");
  }
  function written(result: CloudProjectLinkReply, projectId: string) {
    if (!["saved", "removed"].includes(result.outcome)) {
      const known = {
        forbidden: 403,
        missing: 404,
        conflict: 409,
        ineligible: 409,
      } as const;
      if (Object.hasOwn(known, result.outcome))
        throw new CloudProjectLinkError(
          known[result.outcome as keyof typeof known],
          "CLOUD_PROJECT_LINK_" + result.outcome.toUpperCase(),
        );
      throw new CloudProjectLinkError(503, "CLOUD_PROJECT_STORAGE_UNAVAILABLE");
    }
    const value = link(result.link, projectId);
    if (!value)
      throw new CloudProjectLinkError(503, "CLOUD_PROJECT_STORAGE_UNAVAILABLE");
    return value;
  }
  return {
    read,
    async set(
      projectId: string,
      connectionId: string,
      platformRef: string,
      revision: number,
    ) {
      projectId = identifier(projectId);
      platformRef = identifier(platformRef);
      const current = await read(projectId);
      if (!current.can_manage)
        throw new CloudProjectLinkError(403, "PROJECT_ADMIN_REQUIRED");
      eligible(current);
      if (!Number.isSafeInteger(revision) || revision < 0)
        throw new CloudProjectLinkError(400, "INVALID_LINK_REVISION");
      await remote(connectionId, platformRef);
      // RPC/RLS repeat local authority and revision checks after external I/O.
      return written(
        await options.command("set", projectId, platformRef, revision),
        projectId,
      );
    },
    async remove(projectId: string, revision: number) {
      projectId = identifier(projectId);
      const current = await read(projectId);
      if (!current.can_manage)
        throw new CloudProjectLinkError(403, "PROJECT_ADMIN_REQUIRED");
      if (!Number.isSafeInteger(revision) || revision < 1)
        throw new CloudProjectLinkError(400, "INVALID_LINK_REVISION");
      return written(
        await options.command("remove", projectId, undefined, revision),
        projectId,
      );
    },
    async resolve(projectId: string, connectionId: string) {
      projectId = identifier(projectId);
      const current = await read(projectId);
      eligible(current);
      const link = current.link;
      if (
        !link ||
        link.project_id !== projectId ||
        !uuid.test(link.platform_project_ref)
      )
        throw new CloudProjectLinkError(404, "CLOUD_PROJECT_NOT_LINKED");
      const { sdk, project } = await remote(
        connectionId,
        link.platform_project_ref,
      );
      return {
        sdk,
        cloudProject: project,
        link,
        binding: {
          openlinkUserId: options.userId,
          openlinkProjectId: projectId,
          platformProjectRef: link.platform_project_ref,
        },
      };
    },
  };
}
