/**
 * The cloud agents, declared as a host extension.
 *
 * Starting it builds the manager over the host's own account and the host's own way of turning a conversation into a
 * trace; the completion polling runs on the platform's own interval. The team's policy is asked for before anyone asks
 * about it, so a host that forbids cloud agents can say so without waiting, and stopping the host stops the watching.
 */

import { defineHostExtension } from "../extensions/host-extensions.ts";
import { HostExtensions } from "../extensions/extension-ids.generated.ts";
import { createRealPollingPolicy, realClock } from "../extensions/scheduling.ts";
import { CLOUD_AGENT_POLL_INTERVAL_MS } from "./cloud-agent-poll-loop.ts";
import { SlateCloudAgentManager } from "./cloud-agents-service.ts";

interface CloudAgentExtensionHost {
  convertCloudAgentConversationToTrace(conversation: unknown): readonly unknown[];
}

export const cloudAgentsExtension = defineHostExtension({
  id: HostExtensions.CloudAgents,
  dependencies: [HostExtensions.Auth],
  start: (context) => {
    const auth = context.deps.auth as { getAccessToken(): Promise<string>; getMachineId(): Promise<string> };
    const host = context.host as CloudAgentExtensionHost;
    const service = new SlateCloudAgentManager({
      getCursorAccessToken: auth.getAccessToken,
      getMachineId: auth.getMachineId,
      convertConversationMessagesToTrace: (conversation) => host.convertCloudAgentConversationToTrace(conversation),
      completionPolling: createRealPollingPolicy({ name: "cloud-agent-completion", intervalMs: CLOUD_AGENT_POLL_INTERVAL_MS }),
      clock: realClock,
    });
    context.onStop(() => service.dispose());
    // Asked before anyone asks about it, so the answer is already there when a launch checks it.
    service.prefetchTeamAdminPolicy();
    return service;
  },
});
