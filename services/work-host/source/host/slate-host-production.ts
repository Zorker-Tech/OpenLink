import { startWorkHostExtensions } from "./extensions/registry.ts"
import type { HostExtensionDeclaration } from "./extensions/host-extensions.ts"
import type { HostExtensionId } from "./extensions/extension-ids.generated.ts"
import { createHostRequestContext } from "./host-request-context.ts"
import { createHostRunnerComposition, type HostRunnerCompositionDependencies } from "./host-runner-composition.ts"
import { HostMcpAuthCompletion, type HostMcpAuthCompletionEvent } from "../adapters/interop/mcp/auth-completion-adapter.ts"
import { SlateAgentRunner, type SlateAgentRunnerOptions } from "./runner/slate-agent-runner.ts"
import { withBotBlockDetection } from "./runner/bot-block-detection.ts"
import { withSiteVisitTracking, type ActionAuditor } from "./runner/site-visit-tracking.ts"
import type { ErasedProductionBoxGeneratedPorts } from "./boxes/production.ts"
import { SlateHost, type HostExtensionRegistry, type HostRunnerComposition } from "./slate-host.ts"
import { getSlateAgentsRootDir } from "./storage/agent-paths.ts"
import { BotRuntimeStore, type BotRuntimeBinding } from "./bot/bot-runtime-store.ts"
import { createBotRuntimeGateway } from "./bot/bot-runtime-gateway.ts"
import { createPiBotRunStep } from "./bot/pi-bot-runner.ts"
import { createBotManagementClient } from './bot/bot-management-client.ts'
import { PiWorkerClient } from "./bot/pi-worker-client.ts"
import { generateFirstBotReply } from "./bot/first-bot-reply.ts"
import { InspirationRuntime } from "./inspiration/inspiration-runtime.ts"
import { InspirationStore } from "./inspiration/inspiration-store.ts"
import { getSlateProfilePath, readSlateProfileFile } from "./agents/agent-profile.ts"
import { join } from "node:path"

export interface ProductionSlateHostPorts {
  readonly extensionsById: Readonly<Record<HostExtensionId, HostExtensionDeclaration<unknown, any>>>
  readonly extensionHost: ProductionExtensionHostAdapters
  readonly runnerContext: unknown
  readonly createTranscriptMirror: NonNullable<HostRunnerCompositionDependencies<SlateAgentRunner>["createTranscriptMirror"]>
  readonly buildIdentityFallback?: string
  readonly log?: Pick<Console, "log" | "error">
}

export interface ProductionExtensionHostAdapters {
  readonly boxGenerated: ErasedProductionBoxGeneratedPorts
  readonly standaloneBoxExecDaemon?: boolean
  convertCloudAgentConversationToTrace(conversation: unknown): readonly unknown[]
}

export function createProductionSlateHost(ports: ProductionSlateHostPorts): SlateHost {
  let extensions: HostExtensionRegistry | undefined
  const requireExtensions = (): HostExtensionRegistry => {
    if (extensions == null) throw new Error("the production host extensions have not been started")
    return extensions
  }
  // Bot bindings live beside their agent stores, so a Work-host data-root
  // restore restores the Bot links with the transcripts they belong to.
  const botRuntimeStore = new BotRuntimeStore(getSlateAgentsRootDir())
  const botRuntime = createBotRuntimeGateway(botRuntimeStore)
  const mcpAuthCompletion = new HostMcpAuthCompletion({
    getMcp: () => requireExtensions().api("mcp") as ReturnType<HostMcpAuthCompletion["deps"]["getMcp"]>,
    getTranscript: () => requireExtensions().api("transcript") as unknown as ReturnType<HostMcpAuthCompletion["deps"]["getTranscript"]>,
  })

  return new SlateHost({
    extensionHost: ports.extensionHost,
    botRuntime,
    async startExtensions(host) {
      extensions = (await startWorkHostExtensions({
        host: { ...ports.extensionHost, ...host },
        extensionsById: ports.extensionsById,
      })) as unknown as HostExtensionRegistry
      // The inspiration subscription is a Bot control-plane loop. It is
      // attached here, but only starts once the host says its background work
      // is ready, so its first tick never races the runner graph.
      const transcriptApi = extensions.api("transcript") as unknown as Record<string, any>
      transcriptApi.ackObligations?.setFirstBotReplyGenerator((agentId: string, input: Parameters<typeof generateFirstBotReply>[1], signal: AbortSignal) => {
        const binding = botRuntimeStore.read(agentId)
        return binding ? generateFirstBotReply(new PiWorkerClient(binding), input, signal) : Promise.resolve(null)
      })
      const inspirationRuntime = new InspirationRuntime({
        tm: transcriptApi,
        store: new InspirationStore(getSlateAgentsRootDir()),
        listBindings: () => botRuntimeStore.list(),
        getBinding: (agentId) => botRuntimeStore.read(agentId),
        timeZone: () => {
          const value = transcriptApi.getUserTimeZone?.()
          return typeof value === "string" ? value : undefined
        },
      })
      transcriptApi.inspirationRuntime = inspirationRuntime
      void host.whenBackgroundWorkReady
        .then(() => inspirationRuntime.start())
        .catch(() => undefined)
      return extensions
    },
    createRunnerComposition({ extensions: started, emitGatewayEvent }) {
      return createHostRunnerComposition<SlateAgentRunner>({
        extensions: started,
        ctx: ports.runnerContext,
        emitGatewayEvent,
        botRuntimeProvider: (agentId) => botRuntimeStore.read(agentId),
        buildRunner: (options) => {
          const binding = options.botRuntime as BotRuntimeBinding | undefined
          if (binding === undefined) {
            if (options.requiresBotRuntime === true) throw new Error('Group member Bot runtime is unavailable')
            return new SlateAgentRunner(options as SlateAgentRunnerOptions)
          }
          // A Bot turn runs in the Bot's own sandbox through the shared Pi
          // worker. The ordinary Work-agent turn shell is deliberately not
          // built: its model session and checkpoint belong to Work agents.
          const { productionTurnRunShell: _workAgentTurnShell, ...botOptions } = options as SlateAgentRunnerOptions
          const manageBot = createBotManagementClient(() => botRuntimeStore.read(binding.agentId))
          return new SlateAgentRunner({
            ...botOptions,
            isBotRunner: true,
            runStep: createPiBotRunStep({
              agentId: binding.agentId,
              getBinding: () => botRuntimeStore.read(binding.agentId),
              emitGatewayEvent,
              groupMember: (options as SlateAgentRunnerOptions).isGroupMemberTurn === true,
              ...(manageBot ? { manageBot } : {}),
              ...(typeof options.systemPrompt === 'string' ? { groupSystemPrompt: options.systemPrompt } : {}),
              firstReplyContext: (messageId, signal) => {
                const transcript = started.api('transcript') as unknown as Record<string, any>
                return transcript.ackObligations.firstBotReplyContext(binding.agentId, messageId, signal)
              },
              nominateInspiration: async (target, task) => {
                const transcript = started.api("transcript") as unknown as Record<string, any>
                const runtime = transcript.inspirationRuntime as InspirationRuntime | null | undefined
                if (runtime == null) return { ok: false, reason: "inspiration is not available" }
                const source = botRuntimeStore.read(binding.agentId)
                const candidates = botRuntimeStore.list().filter((candidate) => (
                  candidate.agentId !== binding.agentId
                  && candidate.userId === source?.userId
                  && candidate.workspaceId === source?.workspaceId
                ))
                const normalized = target.trim().toLowerCase()
                let match = candidates.find((candidate) => candidate.agentId === target || candidate.botId === target)
                if (match === undefined) {
                  for (const candidate of candidates) {
                    const profile = readSlateProfileFile(getSlateProfilePath(join(getSlateAgentsRootDir(), candidate.agentId)))
                    if (profile?.name.trim().toLowerCase() === normalized) {
                      match = candidate
                      break
                    }
                  }
                }
                if (match === undefined) return { ok: false, reason: `no sibling Bot named ${target}` }
                return runtime.nominate(binding.agentId, match.agentId, task)
              },
            }),
          })
        },
        createRequestContext: (options) =>
          createHostRequestContext(
            options.transcriptsDir,
            () => {
              const value = options.getUserTimeZone()
              return typeof value === "string" ? value : undefined
            },
            async () => {
              const value = await options.resolveTeamRules()
              return Array.isArray(value) ? value : []
            },
            () => {
              const value = options.getUserFullName()
              return typeof value === "string" ? value : undefined
            },
          ),
        createTranscriptMirror: ports.createTranscriptMirror,
        decorateActionAuditor(auditor, callbacks) {
          return withSiteVisitTracking(
            withBotBlockDetection(auditor as ActionAuditor, callbacks.onBotBlock),
            callbacks.onSiteVisit,
          )
        },
      })
    },
    resolveMcpAuthCompletion(completion) {
      mcpAuthCompletion.resolve(completion as HostMcpAuthCompletionEvent)
    },
    registerConnectorConnectCard(event) {
      mcpAuthCompletion.registerConnectCard(event as Parameters<HostMcpAuthCompletion["registerConnectCard"]>[0])
    },
    createGatewayDependencies(options) {
      return {
        ...options,
        handleDesktopMcpAuthCompletion: (completion) => mcpAuthCompletion.resolveDesktop(completion as HostMcpAuthCompletionEvent),
      }
    },
  })
}
