import "server-only";
import {
  authenticatedCloudContext,
  getCloudConnection,
} from "@/lib/platform-cloud-connection.server";
import {
  createCloudProjectLinks,
  type CloudProjectLinkCommand,
  type CloudProjectLinkReply,
} from "@/lib/platform-cloud-project";

export async function cloudProjectLinksForRequest() {
  const { user, client } = await authenticatedCloudContext();
  const command: CloudProjectLinkCommand = async (
    operation,
    projectId,
    platformRef,
    revision,
  ) => {
    const { data, error } = await client
      .schema("openlink")
      .rpc("cloud_project_link_command", {
        p_operation: operation,
        p_project_id: projectId,
        p_platform_project_ref: platformRef ?? null,
        p_revision: revision ?? null,
      });
    if (error || !data || typeof data !== "object")
      throw new Error("Cloud project link storage failed");
    return data as CloudProjectLinkReply;
  };
  return createCloudProjectLinks({
    mode: "cloud",
    userId: user.id,
    command,
    connection: getCloudConnection,
  });
}
