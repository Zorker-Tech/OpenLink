/**
 * What the host's gateway exposes to the coordinator.
 *
 * The capabilities this host offers are listed here, and each call is validated and answered with the platform's own
 * shapes — a request that does not hold what it must is refused before it reaches the host.
 */

import {
  parseCoordinatorAgentThreadRequest,
  parseCoordinatorTranscriptWindowRequest,
} from "../shared/rpc/coordinator.ts";

export const HOST_CAPABILITIES = [
  "orderedReplicasV1",
  "sendAcceptanceV1"
] as const;
export const CREATE_AGENT_NONCE_LEDGER_CAP = 64;
export const DISABLE_SEND_ACCEPT_RETURN_ENV = "SLATE_DISABLE_SEND_ACCEPT_RETURN";

const SLATE_AGENT_PURPOSES = new Set(["disk-saver", "plugin-auth"]);
const TEMPLATE_ID_PATTERN = /^[a-z0-9-]{1,64}$/;

type DynamicMethod = (...args: any[]) => any;
export type DynamicGatewayApi = Record<string, any>;

export interface HostGatewayDependencies {
  readonly extensions: {
    api(id: string): DynamicGatewayApi;
  };
  readonly hostEvents: {
    emit(event: unknown): unknown;
  };
  readonly rosterBookkeeping?: {
    readonly latestActiveAgentId: string | null;
  };
  decorateForeverBoxStatus(status: any): any;
  getHealth(): { readonly isBusy: boolean };
  kickstartIfPending(agentId: string): Promise<boolean>;
  requestDiskSaverAudit(agentId: string): Promise<boolean>;
  releaseAgentBox(agentId: string): Promise<void>;
  handleDesktopMcpAuthCompletion(completion: unknown): Promise<void>;
  forgetLocalToolPermission(agentId: string): void;
  readonly now?: () => number;
}

function isSlateAgentPurpose(value: unknown): value is string {
  return typeof value === "string" && SLATE_AGENT_PURPOSES.has(value);
}

function sanitizeTemplateId(value: unknown): string | undefined {
  return typeof value === "string" && TEMPLATE_ID_PATTERN.test(value)
    ? value
    : undefined;
}

function call(api: DynamicGatewayApi, name: string): DynamicMethod {
  const candidate = api[name];
  if (typeof candidate !== "function") {
    throw new Error(`host extension method is unavailable: ${name}`);
  }
  return candidate.bind(api);
}

/**
 * Restores the shipped gateway call table. Each call delegates to the
 * extension that owned the behavior in the artifact; the host layer retains
 * cross-cutting nonce dedupe, observability, cleanup, feature gates, and status
 * decoration.
 */
export function createHostGatewayApi(
  ports: HostGatewayDependencies
): Record<string, DynamicMethod> {
  const transcript = ports.extensions.api("transcript");
  const uploads = ports.extensions.api("attachments");
  const schedules = ports.extensions.api("automations");
  const setup = ports.extensions.api("managed-setup");
  const hostSettings = ports.extensions.api("settings");
  const toolPermission = ports.extensions.api("local-tool-permission");
  const observability = ports.extensions.api("telemetry");
  const crossUser = ports.extensions.api("cross-user-sharing");
  const clock = ports.now ?? Date.now;
  const mintsByNonce = new Map<string, Promise<any>>();

  const noteActivity = (reason: "user_action" | "app_open") => {
    call(observability.analytics, "markActive")(reason);
  };

  const mint = async (args: any) => {
    const result = await call(transcript, "createAgent")(
      {
        name: args.name,
        description: args.description,
        ...(args.title === undefined ? {} : { title: args.title }),
        ...(args.avatarShape === undefined
          ? {}
          : { avatarShape: args.avatarShape }),
        ...(args.avatarColor === undefined
          ? {}
          : { avatarColor: args.avatarColor })
      },
      args.origin,
      {
        isIntroductionSuppressed: args.isIntroductionSuppressed ?? false,
        isKickstartRequested: args.isKickstartRequested ?? false,
        ...(isSlateAgentPurpose(args.purpose)
          ? { purpose: args.purpose }
          : {})
      }
    );
    noteActivity("user_action");
    const templateId = sanitizeTemplateId(args.templateId);
    call(observability.analytics, "trackEvent")("slate.agent.created", {
      agent_id: result.agent.id,
      origin: args.origin ?? "user",
      ...(templateId === undefined ? {} : { template_id: templateId })
    });
    return result;
  };

  const open = async (
    args: any,
    operation: "switchAgent" | "openAgentWindowed" | "openAgentTail"
  ) => {
    noteActivity("app_open");
    call(observability, "noteSlateModelExperimentActive")();
    const wasActive = call(transcript, "getActiveAgentId")() === args.id;
    const startedAt = clock();
    const result = operation === "switchAgent"
      ? await call(transcript, operation)(args.id)
      : await call(transcript, operation)(args.id, args.limit);
    const entries = operation === "switchAgent" ? result : result.entries;
    call(observability.logs, "reportAgentOpen")({
      conversationId: args.id,
      durationMs: clock() - startedAt,
      entryCount: entries.length,
      wasActive
    });
    void ports.kickstartIfPending(args.id);
    return result;
  };

  const share = async (name: string, args: any) => {
    noteActivity("user_action");
    return await call(crossUser, name)(args);
  };

  const routedTools = async () => {
    const extension = ports.extensions.api("mcp");
    const mcp = extension.mcp;
    const tools = await call(mcp, "listTools")({});
    return tools.map((tool: any) => ({
      name: tool.name,
      providerIdentifier: tool.providerIdentifier,
      toolName: tool.toolName,
      ...(tool.description == null ? {} : { description: tool.description }),
      ...(tool.inputSchema == null ? {} : { inputSchema: typeof tool.inputSchema.toJson === "function" ? tool.inputSchema.toJson() : tool.inputSchema }),
    }));
  };
  const routedExecute = async (args: any) => {
    const mcp = ports.extensions.api("mcp").mcp;
    const executor = call(mcp, "createExecutor")(undefined, undefined, { agentId: args.agentId });
    return await call(executor, "execute")({}, {
      name: args.toolName,
      toolName: args.name,
      providerIdentifier: args.providerIdentifier,
      args: args.args,
      toolCallId: args.toolCallId,
    });
  };

  return {
    getTranscript: () => call(transcript, "ensureLoaded")(),
    getAgentTranscript: (args: any) =>
      call(transcript, "getAgentTranscript")(args.id),
    getAgentTranscriptPage: (args: any) =>
      call(transcript, "getAgentTranscriptPage")(args.id, args),
    getAgentTranscriptWindow: (args: unknown) => {
      const request = parseCoordinatorTranscriptWindowRequest(args);
      if (request == null) throw new Error("Malformed getAgentTranscriptWindow request");
      return call(transcript, "getAgentTranscriptWindow")(request.id, args);
    },
    getAgentTranscriptTail: (args: any) =>
      call(transcript, "getAgentTranscriptTail")(args.id, args),
    getAgentThread: (args: unknown) => {
      const request = parseCoordinatorAgentThreadRequest(args);
      if (request == null) throw new Error("Malformed getAgentThread request");
      return call(transcript, "getAgentThread")(request.id, request.rootId);
    },

    sendPrompt: async (args: any) => {
      const agentId =
        (typeof args.agentId === "string" && args.agentId.length > 0
          ? args.agentId
          : undefined) ??
        call(transcript, "getActiveAgentId")() ??
        ports.rosterBookkeeping?.latestActiveAgentId ??
        "unknown";
      call(observability, "reportMessageSent")({
        ...args,
        agentId,
        isGroupRoom: call(transcript, "listAgentsSync")()
          .find((agent: any) => agent.id === agentId)?.isGroup === true
      });
      await call(transcript, "sendPrompt")(args.prompt, {
        agentId: args.agentId,
        directAddressedAcceptance: args.directAddressedAcceptance,
        attachmentPaths: args.attachmentPaths ?? [],
        attachmentNames: args.attachmentNames ?? [],
        richText: args.richText,
        replyToId: args.replyToId,
        clientNonce: args.clientNonce,
        isFork: args.isFork,
        traceparent: args.traceparent,
        enterEpochMs: args.enterEpochMs,
        composedAtMs: args.composedAtMs,
        awaitTurn: process.env[DISABLE_SEND_ACCEPT_RETURN_ENV] === "1"
      });
      return { accepted: true };
    },
    promptAcceptanceStatus: (args: any) =>
      call(transcript, "promptAcceptanceStatus")(args),
    respondToWidget: (args: any) => {
      noteActivity("user_action");
      call(observability.analytics, "trackEvent")("slate.widget.responded", {
        agent_id: args.agentId
      });
      return call(transcript, "respondToWidget")(
        args.entryId,
        args.value,
        args.agentId
      );
    },
    resolveAutoReviewApproval: (args: any) => {
      noteActivity("user_action");
      return call(
        ports.extensions.api("auto-review"),
        "resolveApproval"
      )(args);
    },
    resolveLocalToolPermission: async (args: any) => {
      noteActivity("user_action");
      await call(toolPermission, "resolveAsk")(args);
    },
    dismissWidget: (args: any) => {
      noteActivity("user_action");
      call(observability.analytics, "trackEvent")("slate.widget.dismissed", {
        agent_id: args.agentId
      });
      return call(transcript, "dismissWidget")(args);
    },
    submitSecret: (args: any) =>
      call(transcript, "submitSecret")(
        args.entryId,
        args.value,
        args.agentId
      ),
    reactToMessage: (args: any) => {
      noteActivity("user_action");
      call(observability.analytics, "trackEvent")("slate.reaction.added", {
        agent_id: args.agentId
      });
      return call(transcript, "reactToMessage")(
        args.entryId,
        args.emoji,
        args.agentId
      );
    },
    appendConnectorCard: (args: any) =>
      call(transcript, "appendConnectorCard")(args),

    listAgents: () => call(transcript, "listAgents")(),
    countAgents: () => call(transcript, "countAgentsOnDisk")(),
    searchAgents: async (args: any) =>
      await call(ports.extensions.api("content-search"), "isEnabled")()
        ? call(transcript, "searchAgents")(args.query, args.limit)
        : [],
    searchMedia: async (args: any) =>
      await call(ports.extensions.api("content-search"), "isEnabled")()
        ? call(transcript, "searchMedia")(args.query, args.limit)
        : [],
    createAgent: (args: any) => {
      const nonce = args.clientNonce;
      if (nonce == null || nonce.length === 0) return mint(args);
      const pending = mintsByNonce.get(nonce);
      if (pending != null) return pending;

      const minted = mint(args);
      mintsByNonce.set(nonce, minted);
      void minted.catch(() => mintsByNonce.delete(nonce));
      for (const oldest of mintsByNonce.keys()) {
        if (mintsByNonce.size <= CREATE_AGENT_NONCE_LEDGER_CAP) break;
        mintsByNonce.delete(oldest);
      }
      return minted;
    },
    kickstartAgent: async (args: any) => ({
      isIntroductionInFlight: await ports.kickstartIfPending(args.id)
    }),
    requestDiskSaverAudit: async (args: any) => ({
      isAuditInFlight: await ports.requestDiskSaverAudit(args.id)
    }),
    createGroup: (args: any) => call(transcript, "createGroup")({
      name: args.name,
      description: args.description,
      memberIds: args.memberAgentIds
    }),
    setGroupMembers: (args: any) =>
      call(transcript, "setGroupMembers")(args.id, args.memberAgentIds),
    updateAgent: (args: any) =>
      call(transcript, "updateAgent")(args.id, args.profile),
    deleteAgent: async (args: any) => {
      await call(crossUser, "noteAgentDeleted")(args.id);
      const result = await call(transcript, "deleteAgent")(args.id);
      call(ports.extensions.api("session"), "forgetHandoff")(args.id);
      await call(schedules, "deleteAgentSchedules")(args.id).catch(
        () => undefined
      );
      await ports.releaseAgentBox(args.id);
      ports.hostEvents.emit({
        kind: "notification-agent-forgotten",
        agentId: args.id
      });
      ports.forgetLocalToolPermission(args.id);
      return result;
    },
    deleteAgents: async (args: any) => {
      for (const id of args.ids) {
        await call(crossUser, "noteAgentDeleted")(id);
      }
      const result = await call(transcript, "deleteAgents")(args.ids);
      for (const id of args.ids) {
        call(ports.extensions.api("session"), "forgetHandoff")(id);
        await call(schedules, "deleteAgentSchedules")(id).catch(
          () => undefined
        );
        await ports.releaseAgentBox(id);
        ports.hostEvents.emit({
          kind: "notification-agent-forgotten",
          agentId: id
        });
        ports.forgetLocalToolPermission(id);
      }
      return result;
    },
    duplicateAgent: (args: any) => call(transcript, "cloneAgent")(args.id),
    setAgentUnread: (args: any) =>
      call(transcript, "setAgentUnread")(args.id, args.isUnread, args.atMs),
    setAgentNotificationsEnabled: async () => undefined,
    setAgentNotifyOnUpdates: (args: any) =>
      call(transcript, "setAgentNotifyOnUpdates")(args.id, args.isEnabled),
    setAgentHiddenFromSidebar: (args: any) =>
      call(transcript, "setAgentHiddenFromSidebar")(args.id, args.isHidden),
    openAgent: (args: any) => open(args, "switchAgent"),
    openAgentWindowed: (args: any) => open(args, "openAgentWindowed"),
    openAgentTail: (args: any) => open(args, "openAgentTail"),
    setWindowFocused: (args: any) =>
      call(transcript, "setWindowFocused")(args.isFocused),

    getAgentMemories: (args: any) =>
      call(transcript, "getAgentMemories")(args.id),
    deleteAgentMemory: (args: any) =>
      call(transcript, "deleteAgentMemory")(args.id, args.memoryId),
    clearAgentMemories: (args: any) =>
      call(transcript, "clearAgentMemories")(args.id),
    getAgentAutomations: (args: any) =>
      call(transcript, "getAgentAutomations")(args.id),
    listAllAutomations: () => call(transcript, "listAllAutomations")(),
    isAgentNetworkEnabled: () =>
      call(ports.extensions.api("experiments"), "isAgentNetworkEnabled")(),
    isGlobalSearchEnabled: () =>
      call(ports.extensions.api("content-search"), "isEnabled")(),
    isEgressTunnelAvailable: async () =>
      process.env.SLATE_EGRESS_TUNNEL_ENABLED === "1",

    getSharingState: () => call(crossUser, "getSharingState")(),
    createRoomFromAgent: (args: any) =>
      share("createRoomFromAgent", args),
    createRoomInvite: (args: any) =>
      share("createRoomInvite", args),
    joinSharedRoom: (args: any) => share("joinSharedRoom", args),
    respondToRoomJoinRequest: (args: any) =>
      share("respondToRoomJoinRequest", args),
    createSharedRoom: (args: any) =>
      share("createSharedRoom", args),
    addOwnAgentToSharedRoom: (args: any) =>
      share("addOwnAgentToSharedRoom", args),
    removeOwnAgentFromSharedRoom: (args: any) =>
      share("removeOwnAgentFromSharedRoom", args),
    setSharedRoomTyping: (args: any) =>
      call(crossUser, "setSharedRoomTyping")(args),
    leaveSharedRoom: (args: any) => share("leaveSharedRoom", args),

    setAgentAutomationEnabled: (args: any) =>
      call(transcript, "setAgentAutomationEnabled")(
        args.id,
        args.automationId,
        args.isEnabled
      ),
    createAgentAutomation: async (args: any) => {
      noteActivity("user_action");
      const countBefore = (await call(transcript, "getAgentAutomations")(
        args.id
      )).length;
      const created = await call(transcript, "createAgentAutomation")(
        args.id,
        args.spec
      );
      if (created.length > countBefore) {
        call(observability.analytics, "trackEvent")("slate.automation.created", {
          agent_id: args.id,
          trigger_type: args.spec.trigger.type,
          source: "automations_ui"
        });
      }
      return created;
    },
    updateAgentAutomation: (args: any) =>
      call(transcript, "updateAgentAutomation")(
        args.id,
        args.automationId,
        args.spec
      ),
    deleteAgentAutomation: (args: any) =>
      call(transcript, "deleteAgentAutomation")(args.id, args.automationId),
    runAgentAutomationNow: (args: any) => {
      noteActivity("user_action");
      return call(transcript, "runAgentAutomationNow")(
        args.id,
        args.automationId
      );
    },
    broadcastToAgents: async (args: any) => {
      noteActivity("user_action");
      const result = await call(transcript, "broadcastToAgents")(
        args.targets,
        args.message
      );
      call(observability.analytics, "trackEvent")("slate.broadcast.sent", {
        total: result.total,
        scheduled: result.scheduled,
        targets: args.targets === "all" ? "all" : "subset"
      });
      return result;
    },

    getAgentWorkflows: (args: any) =>
      call(transcript, "getAgentWorkflows")(args.id),
    createAgentWorkflow: async (args: any) => {
      const isAutomation = args.spec.trigger != null;
      if (isAutomation) noteActivity("user_action");
      const countBefore = isAutomation
        ? (await call(transcript, "getAgentAutomations")(args.id)).length
        : 0;
      const workflows = await call(transcript, "createAgentWorkflow")(
        args.id,
        args.spec
      );
      if (isAutomation) {
        const countAfter = (await call(transcript, "getAgentAutomations")(
          args.id
        )).length;
        if (countAfter > countBefore) {
          call(observability.analytics, "trackEvent")(
            "slate.automation.created",
            {
              agent_id: args.id,
              trigger_type: "cron",
              source: "workflow_ui"
            }
          );
        }
      }
      return workflows;
    },
    updateAgentWorkflow: (args: any) =>
      call(transcript, "updateAgentWorkflow")(
        args.id,
        args.workflowId,
        args.spec
      ),
    setAgentWorkflowEnabled: (args: any) =>
      call(transcript, "setAgentWorkflowEnabled")(
        args.id,
        args.workflowId,
        args.isEnabled
      ),
    deleteAgentWorkflow: (args: any) =>
      call(transcript, "deleteAgentWorkflow")(args.id, args.workflowId),
    runAgentWorkflowNow: (args: any) =>
      call(transcript, "runAgentWorkflowNow")(args.id, args.workflowId),
    importAgentWorkflowText: (args: any) =>
      call(transcript, "importAgentWorkflowMarkdown")(
        args.id,
        args.markdown,
        args.name
      ),
    importAgentWorkflowUrl: (args: any) =>
      call(transcript, "importAgentWorkflowUrl")(args.id, args.url, args.name),
    portAgentLocalSkills: (args: any) =>
      call(transcript, "portAgentLocalSkills")(args.id),
    getConversationOutline: (args: any) =>
      call(transcript, "getConversationOutline")(args.id),

    skillsCatalog: () => call(setup, "skillsCatalog")(),
    syncPluginSkills: () =>
      call(ports.extensions.api("mcp"), "syncPluginSkills")(),
    getPluginSyncStatus: () =>
      call(ports.extensions.api("mcp"), "pluginSyncStatus")(),
    getSkillPublishTargets: () =>
      call(ports.extensions.api("mcp").skillPublish, "listTargets")(),
    publishSkill: (args: any) =>
      call(ports.extensions.api("mcp").skillPublish, "publish")(args),
    resyncPublishedSkill: (args: any) =>
      call(ports.extensions.api("mcp").skillPublish, "resync")(args),
    unpublishSkill: (args: any) =>
      call(ports.extensions.api("mcp").skillPublish, "unpublish")(args),

    getAgentChannels: (args: any) =>
      call(schedules, "getAgentChannels")(args.id),
    connectChannel: async (args: any) => {
      call(transcript, "connectChannel")(args.id, args.platform, args.token);
      return call(schedules, "getAgentChannels")(args.id);
    },
    disconnectChannel: async (args: any) => {
      call(transcript, "disconnectChannel")(args.id, args.platform);
      return call(schedules, "getAgentChannels")(args.id);
    },
    refreshChannel: (args: any) =>
      call(schedules, "getAgentChannels")(args.id),
    getListenerIntegrations: () =>
      call(schedules, "getListenerIntegrations")(),
    getListenerConnectUrl: async (args: any) => ({
      url: await call(schedules, "getListenerConnectUrl")(args.platform)
    }),
    getSubagents: (args: any) => call(transcript, "getSubagents")(args.id),
    getAsyncTasks: (args: any) => call(transcript, "getAsyncTasks")(args.id),
    setAgentAvatarBytes: (args: any) =>
      call(transcript, "setAgentAvatarBytes")(
        args.id,
        args.pngBase64 == null
          ? null
          : Uint8Array.from(Buffer.from(args.pngBase64, "base64"))
      ),
    getAgentAvatar: (args: any) => call(transcript, "getAgentAvatar")(args.id),

    getForeverBoxStatus: async (args: any) =>
      ports.decorateForeverBoxStatus(
        await call(ports.extensions.api("forever-box"), "getStatus")(args)
      ),
    getCloudAgentInfo: (args: any) =>
      call(ports.extensions.api("cloud-agents"), "getInfo")(
        args.agentId,
        args.includeFiles
      ),
    ensureForeverBox: async (args: any) =>
      ports.decorateForeverBoxStatus(
        await call(ports.extensions.api("forever-box"), "ensure")(args)
      ),
    resetForeverBox: async (args: any) =>
      ports.decorateForeverBoxStatus(
        await call(ports.extensions.api("forever-box"), "reset")(args)
      ),
    updateForeverBox: async (args: any) =>
      ports.decorateForeverBoxStatus(
        await call(ports.extensions.api("forever-box"), "update")(args)
      ),
    autoUpdateBoxNow: () =>
      call(ports.extensions.api("forever-box"), "autoUpdateNow")(),
    snapshotBoxStoreNow: (args: any) =>
      call(ports.extensions.api("box-store-sync"), "snapshotBoxStoreNow")(
        args
      ),
    getBoxStoreStatus: () =>
      call(ports.extensions.api("box-store-sync"), "getBoxStoreStatus")(),
    clearBoxStoreNow: () =>
      call(ports.extensions.api("box-store-sync"), "clearBoxStoreNow")(),
    updateHostNow: (args: any) =>
      call(ports.extensions.api("host-upgrade"), "updateHostNow")(args),
    getHostStatus: async () => ({
      ...call(ports.extensions.api("host-upgrade"), "getVersionState")(),
      isBusy: ports.getHealth().isBusy,
      capabilities: HOST_CAPABILITIES
    }),
    setBoxMigrating: async (args: any) => {
      call(ports.extensions.api("forever-box"), "setMigrating")({
        migrating: args.migrating === true
      });
      return { ok: true };
    },
    prepareBoxForRecreate: async () => {
      await call(schedules, "suspendWakes")();
      return await call(transcript, "quiesceForRecreate")();
    },
    resumeBoxAfterRecreate: async (args: any) => {
      call(schedules, "resumeWakes")();
      await call(crossUser, "resumeAfterRecreate")();
      return await call(transcript, "resumeAfterRecreate")(
        args.agentIds ?? [],
        args.pendingWakes
      );
    },
    handBackForeverBox: (args: any) =>
      call(ports.extensions.api("session"), "endHandoff")(
        args.id,
        args.trigger ?? "button"
      ),

    startTeachRecording: (args: any) =>
      call(ports.extensions.api("teach-recording"), "start")(args),
    stopTeachRecording: (args: any) =>
      call(ports.extensions.api("teach-recording"), "stop")(args),
    getTeachRecordingStatus: () =>
      call(ports.extensions.api("teach-recording"), "getStatus")(),
    getTrays: () => call(ports.extensions.api("trays"), "list")(),
    dismissTray: (args: any) =>
      call(ports.extensions.api("trays"), "dismiss")(args),
    clearTrays: () => call(ports.extensions.api("trays"), "clearAll")(),

    uploadAttachment: (args: any) => call(uploads, "upload")(args),
    readAttachmentImage: (args: any) => call(uploads, "readImage")(args),
    readAttachmentText: (args: any) => call(uploads, "readText")(args),
    readAttachmentChunk: (args: any) => call(uploads, "readChunk")(args),
    getHostSettings: () => call(hostSettings, "getHostSettings")(),
    setHostSettings: (args: any) => {
      const result = call(hostSettings, "setHostSettings")(args);
      if (args.localToolPermission !== undefined) {
        call(toolPermission, "notePermissionChanged")();
      }
      if (args.webauthnProxyEnabled !== undefined) {
        call(ports.extensions.api("webauthn-proxy"), "applyEnablement")(
          args.webauthnProxyEnabled
        );
      }
      return result;
    },

    refreshMcp: async ({ completion, routedAction, routedArgs }: any) => {
      if (routedAction === "list-tools") return await routedTools();
      if (routedAction === "execute-tool") return await routedExecute(routedArgs);
      if (completion != null) {
        await ports.handleDesktopMcpAuthCompletion(completion);
        return;
      }
      await call(ports.extensions.api("mcp").management, "restart")();
    },
    listRoutedMcpTools: routedTools,
    executeRoutedMcpTool: routedExecute,
    listBoxMcpServers: async ({ serverIdentifiers }: any) => {
      const servers = await call(
        ports.extensions.api("mcp"),
        "listBoxServers"
      )(serverIdentifiers);
      return {
        servers: servers.map((server: any) => ({
          serverIdentifier: server.serverIdentifier,
          status: server.status,
          ...(server.statusDetail == null
            ? {}
            : { statusDetail: server.statusDetail }),
          toolCount: server.toolCount
        }))
      };
    },
    completeMcpOAuth: async () => undefined,
    requestWebAuthnCeremony: (args: any) =>
      call(ports.extensions.api("webauthn-proxy"), "requestCeremony")(args),
    setBoxSecrets: ({ secrets }: any) =>
      call(ports.extensions.api("secrets"), "set")({ secrets }),
    getBoxSecretsStatus: () =>
      call(ports.extensions.api("secrets"), "getStatus")()
  };
}
