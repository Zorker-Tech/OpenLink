/** Connect the cloud-agent manager to host authentication, tracing, and shutdown. */

import type { HostExtensionContext } from "../extensions/host-extensions.ts";
import { defineHostExtension } from "../extensions/host-extensions.ts";
import { HostExtensions } from "../extensions/extension-ids.generated.ts";
import { createRealPollingPolicy, realClock } from "../extensions/scheduling.ts";
import { CLOUD_AGENT_POLL_INTERVAL_MS } from "./cloud-agent-poll-loop.ts";
import { SlateCloudAgentManager } from "./cloud-agents-service.ts";

interface CloudAgentHostPort {
  convertCloudAgentConversationToTrace(conversation: unknown): readonly unknown[];
}

interface AuthPort {
  getAccessToken(): Promise<string>;
  getMachineId(): Promise<string>;
}

function managerForHost(context: HostExtensionContext<CloudAgentHostPort>): SlateCloudAgentManager {
  const auth = context.deps.auth as AuthPort;
  const host = context.host;

  return new SlateCloudAgentManager({
    getAccessToken: () => auth.getAccessToken(),
    getMachineId: () => auth.getMachineId(),
    convertConversationMessagesToTrace: (conversation) => host.convertCloudAgentConversationToTrace(conversation),
    completionPolling: createRealPollingPolicy({
      name: "cloud-agent-completion",
      intervalMs: CLOUD_AGENT_POLL_INTERVAL_MS,
    }),
    clock: realClock,
  });
}

function startCloudAgentExtension(context: HostExtensionContext<CloudAgentHostPort>): SlateCloudAgentManager {
  const manager = managerForHost(context);
  context.onStop(() => manager.dispose());
  manager.prefetchTeamAdminPolicy();
  return manager;
}

export const cloudAgentsExtension = defineHostExtension({
  id: HostExtensions.CloudAgents,
  dependencies: [HostExtensions.Auth],
  start: startCloudAgentExtension,
});
