/** Sharing a room with another user's computer, wired as a host extension. */
import { defineHostExtension } from "../extensions/host-extensions.ts";
import { HostExtensions } from "../extensions/extension-ids.generated.ts";
import { getConfiguredBackendUrl } from "../../shared/node/slate-token.ts";
import { resolveXuserSharingEnvironment } from "./xuser-sharing-environment.ts";
import { createCrossUserSharingApi } from "./xuser-sharing-extension-api.ts";
import {
  createCrossUserSharingEnabledState,
  createCrossUserSharingLifecycle,
} from "./xuser-sharing-extension-lifecycle.ts";
import { createCrossUserSharingService } from "./xuser-sharing-extension-service.ts";
import type {
  CrossUserSharingServiceSources,
  SharingFeatureGate,
  SharingHost,
} from "./xuser-sharing-extension-contracts.ts";

export { SHARING_DISABLED_MESSAGE } from "./xuser-sharing-extension-contracts.ts";

/** Register the sharing service, its feature gate, and the API returned to the host. */
export function createCrossUserSharingExtension() {
  return defineHostExtension<unknown, SharingHost>({
    id: HostExtensions.CrossUserSharing,
    dependencies: [
      HostExtensions.Attachments,
      HostExtensions.Auth,
      HostExtensions.Experiments,
      HostExtensions.Transcript,
      HostExtensions.NotifyBus,
    ],
    start: (context) => {
      const auth = context.deps[HostExtensions.Auth] as CrossUserSharingServiceSources["auth"];
      const transcript = context.deps[HostExtensions.Transcript] as CrossUserSharingServiceSources["manager"];
      const attachments = context.deps[HostExtensions.Attachments] as CrossUserSharingServiceSources["attachments"];
      const notifyBus = context.deps[HostExtensions.NotifyBus] as CrossUserSharingServiceSources["notifyBus"] & {
        onNotify(topic: string, callback: () => void): () => void;
      };
      const experiments = context.deps[HostExtensions.Experiments] as {
        getFeatureGateProperty(name: string): SharingFeatureGate;
      };
      const listeners = new Set<(state: unknown) => void>();
      const enabledState = createCrossUserSharingEnabledState();
      const service = createCrossUserSharingService({
        auth,
        manager: transcript,
        attachments,
        notifyBus,
        isEnabled: () => enabledState.isEnabled,
        emitSharing: (state) => {
          for (const listener of listeners) listener(state);
        },
      });

      context.onStop(notifyBus.onNotify("xuser-events", () => {
        if (enabledState.isEnabled) service.requestRelayDrain();
      }));

      let lifecycle!: ReturnType<typeof createCrossUserSharingLifecycle>;
      context.onStop(() => lifecycle.stop());
      const environment = resolveXuserSharingEnvironment({ backendUrl: getConfiguredBackendUrl() });
      lifecycle = createCrossUserSharingLifecycle({
        service,
        enabledState,
        transcript,
        host: context.host,
        environment,
        listeners,
      });

      void context.host.whenBackgroundWorkReady.then(() => {
        if (lifecycle.isStopped) return;
        const gate = experiments.getFeatureGateProperty("slate_multiplayer");
        context.onStop(gate.subscribe(lifecycle.applyGuardedGate));
        lifecycle.applyGuardedGate(gate.get());
      });

      return createCrossUserSharingApi({ service, isEnabled: () => enabledState.isEnabled, listeners });
    },
  });
}

export const crossUserSharingExtension = createCrossUserSharingExtension();
