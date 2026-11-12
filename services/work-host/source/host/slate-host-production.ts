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
          if (binding === undefined) return new SlateAgentRunner(options as SlateAgentRunnerOptions)
          // A Bot turn runs in the Bot's own sandbox through the shared Pi
          // worker. The ordinary Work-agent turn shell is deliberately not
          // built: its model session and checkpoint belong to Work agents.
          const { productionTurnRunShell: _workAgentTurnShell, ...botOptions } = options as SlateAgentRunnerOptions
          return new SlateAgentRunner({
            ...botOptions,
            isBotRunner: true,
            runStep: createPiBotRunStep({
              agentId: binding.agentId,
              getBinding: () => botRuntimeStore.read(binding.agentId),
              emitGatewayEvent,
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
