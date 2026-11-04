import { resolveMultitaskEnabled } from "../../slate-multitask.ts"
import { resolveSpotlightEnabled } from "../../../shared/slate-spotlight.ts"
import { SlateExperimentService } from "../../../shared/node/experiments/slate-experiment-service.ts"

const SERVICE_API_METHODS = [
  "checkFeatureGate",
  "getFeatureGateProperty",
  "checkGate",
  "getDynamicConfig",
  "subscribe",
  "pinGateOnAuthenticatedBootstrap",
  "hasHydratedExperimentUser",
  "waitForHydratedExperimentUser",
  "hasAuthenticatedBootstrap",
  "getSlateModelExperimentState",
  "logSlateModelExperimentExposure",
  "getConfiguredDefaultModel",
  "getConfiguredAutomationsModel",
  "getComputerUseModelOverride",
  "getBrowserUseModelOverride",
] as const satisfies readonly (keyof SlateExperimentService)[]

type ServiceApiMethod = (typeof SERVICE_API_METHODS)[number]

const BOOLEAN_GATE_METHODS = [
  ["isAgentNetworkEnabled", "slate_agent_network"],
  ["isMcpMultiAccountEnabled", "mcp_multi_account"],
  ["isSparsePluginClonesEnabled", "enable_sparse_plugin_clones"],
  ["isSendMessageDeliveryOwedEnabled", "slate_send_message_delivery_owed"],
  ["isDynamicToolsEnabled", "slate_dynamic_tools"],
  ["isBrowserUseSubagentEnabled", "slate_browser_use_subagent"],
  ["isUnicodeTypingEnabled", "slate_computer_use_unicode_typing"],
  ["isUaTokenKillSwitchEnabled", "slate_browser_ua_token_kill_switch"],
] as const satisfies readonly (readonly [string, Parameters<SlateExperimentService["checkFeatureGate"]>[0]])[]

type BooleanGateMethod = (typeof BOOLEAN_GATE_METHODS)[number][0]
type BooleanGateApi = Record<BooleanGateMethod, () => boolean>

function bindServiceMethods(service: SlateExperimentService): Pick<SlateExperimentService, ServiceApiMethod> {
  return Object.fromEntries(
    SERVICE_API_METHODS.map(method => [method, service[method].bind(service)]),
  ) as Pick<SlateExperimentService, ServiceApiMethod>
}

function bindBooleanGateMethods(service: SlateExperimentService): BooleanGateApi {
  return Object.fromEntries(
    BOOLEAN_GATE_METHODS.map(([method, gate]) => [method, () => service.checkFeatureGate(gate)]),
  ) as BooleanGateApi
}

export function createExperimentsExtensionApi(
  service: SlateExperimentService,
  environment: NodeJS.ProcessEnv = process.env,
) {
  return Object.assign(bindServiceMethods(service), bindBooleanGateMethods(service), {
    isMultitaskEnabled: () => resolveMultitaskEnabled(
      environment.SLATE_MULTITASK,
      () => service.checkFeatureGate("slate_multitask"),
    ),
    isSpotlightEnabled: () => resolveSpotlightEnabled(
      environment.SLATE_SPOTLIGHT,
      () => service.checkFeatureGate("slate_spotlight"),
    ),
  })
}
