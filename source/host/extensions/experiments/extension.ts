/**
 * The experiments, declared as a host extension.
 *
 * Starting it brings the experiment service up over the host's auth and settings, keeps it in step with account
 * renewals and with the flag overrides the settings surface sends, and hands back the one place the rest of the host asks
 * about gates, experiments, dynamic configs and the model overrides.
 */
import { defineHostExtension } from "../host-extensions.ts";
import { getSlateRootDir } from "../../host-paths.ts";
import { resolveMultitaskEnabled } from "../../slate-multitask.ts";
import { resolveSpotlightEnabled } from "../../../shared/slate-spotlight.ts";
import { SlateExperimentService } from "../../../shared/node/experiments/slate-experiment-service.ts";
import { HostExtensions } from "../extension-ids.generated.ts";

interface AuthApi { getAccessToken(options: { backendUrl: string }): Promise<string>; getMachineId(): Promise<string>; peekAccessToken(): string | null; subscribeToRenewal(listener: (event: { outcome: string; isFirstCredential: boolean }) => void): () => void; }
interface SettingsApi { subscribeToFeatureFlagOverrides(listener: (overrides: Record<string, boolean>) => void): () => void; }
export const experimentsExtension = defineHostExtension({
  id: HostExtensions.Experiments, dependencies: [HostExtensions.Auth, HostExtensions.Settings],
  start: (context) => {
    const auth = context.deps[HostExtensions.Auth] as AuthApi; const settings = context.deps[HostExtensions.Settings] as SettingsApi;
    const service = new SlateExperimentService({ getAccessToken: auth.getAccessToken, getMachineId: auth.getMachineId, getCacheDir: () => getSlateRootDir(), isDevBuild: process.env.SLATE_PACKAGED !== "1" || process.env.SLATE_HOST_DEV_ERROR_DETAIL === "1" });
    service.start(); context.onStop(() => service.dispose()); context.onStop(auth.subscribeToRenewal((event) => { if (event.outcome === "renewed" && (event.isFirstCredential || !service.hasAuthenticatedBootstrap())) service.handleAuthChange(); }));
    if (auth.peekAccessToken() !== null) service.handleAuthChange(); context.onStop(settings.subscribeToFeatureFlagOverrides((overrides) => service.replaceFeatureFlagOverrides(overrides)));
    return {
      checkFeatureGate: (name: Parameters<typeof service.checkFeatureGate>[0]) => service.checkFeatureGate(name), getFeatureGateProperty: (name: Parameters<typeof service.getFeatureGateProperty>[0]) => service.getFeatureGateProperty(name),
      checkGate: (name: Parameters<typeof service.checkGate>[0], options?: { timeoutMs?: number }) => service.checkGate(name, options), getDynamicConfig: (name: Parameters<typeof service.getDynamicConfig>[0]) => service.getDynamicConfig(name), subscribe: (listener: Parameters<typeof service.subscribe>[0]) => service.subscribe(listener),
      pinGateOnAuthenticatedBootstrap: (name: Parameters<typeof service.pinGateOnAuthenticatedBootstrap>[0], pin: (value: boolean) => void) => service.pinGateOnAuthenticatedBootstrap(name, pin), hasHydratedExperimentUser: () => service.hasHydratedExperimentUser(), waitForHydratedExperimentUser: (timeoutMs?: number) => service.waitForHydratedExperimentUser(timeoutMs),
      hasAuthenticatedBootstrap: () => service.hasAuthenticatedBootstrap(), getSlateModelExperimentState: () => service.getSlateModelExperimentState(), logSlateModelExperimentExposure: () => service.logSlateModelExperimentExposure(), getConfiguredDefaultModel: () => service.getConfiguredDefaultModel(), getConfiguredAutomationsModel: () => service.getConfiguredAutomationsModel(), getComputerUseModelOverride: () => service.getComputerUseModelOverride(), getBrowserUseModelOverride: () => service.getBrowserUseModelOverride(),
      isAgentNetworkEnabled: () => service.checkFeatureGate("slate_agent_network"), isMcpMultiAccountEnabled: () => service.checkFeatureGate("mcp_multi_account"), isSparsePluginClonesEnabled: () => service.checkFeatureGate("enable_sparse_plugin_clones"),
      isMultitaskEnabled: () => resolveMultitaskEnabled(process.env.SLATE_MULTITASK, () => service.checkFeatureGate("slate_multitask")), isSendMessageDeliveryOwedEnabled: () => service.checkFeatureGate("slate_send_message_delivery_owed"), isDynamicToolsEnabled: () => service.checkFeatureGate("slate_dynamic_tools"), isBrowserUseSubagentEnabled: () => service.checkFeatureGate("slate_browser_use_subagent"),
      isSpotlightEnabled: () => resolveSpotlightEnabled(process.env.SLATE_SPOTLIGHT, () => service.checkFeatureGate("slate_spotlight")), isUnicodeTypingEnabled: () => service.checkFeatureGate("slate_computer_use_unicode_typing"), isUaTokenKillSwitchEnabled: () => service.checkFeatureGate("slate_browser_ua_token_kill_switch")
    };
  }
});
