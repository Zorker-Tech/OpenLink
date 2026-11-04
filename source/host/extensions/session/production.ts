import type { HostExtensionContext } from "../host-extensions.ts";
import { createContext } from "../../../packages/context/context.ts";
import { loggerKey } from "../../../packages/context/logging.ts";
import { getSlateAgentsRootDir } from "../../storage/agent-paths.ts";
import type { BoxHandoffDeps } from "./box-handoff-service.ts";
import type { SessionExtensionContext } from "./extension.ts";
import { createSessionProductionHandoffDependencies } from "./session-production-handoff.ts";
import { createSessionStoreFactory } from "./session-production-store.ts";
import { getSlateTranscriptsDir } from "./session-paths.ts";

interface SessionProductionDependencies {
  readonly "forever-box": {
    readonly box: {
      ensureReady(context: ReturnType<typeof createContext>, agentId: string): Promise<{
        readonly remoteAccessor?: unknown;
      }>;
    };
  };
  readonly telemetry: {
    readonly logs: {
      reportBoxHelp(event: Record<string, unknown>): void;
      reportSessionDiagnostic?(event: Record<string, unknown>): void;
    };
    readonly analytics: {
      trackEvent(name: string, properties: Record<string, unknown>): void;
    };
  };
}

interface SessionProductionHost {
  readonly events: {
    emit(topic: string, payload: unknown, options?: { failureMode?: "reject" }): Promise<void>;
  };
}

type SessionProductionContext = HostExtensionContext<SessionProductionHost> & {
  readonly deps: SessionProductionDependencies;
};

/** Bind the session extension to its persistent stores and host notification ports. */
export function createSessionProductionExtras(
  hostContext: SessionProductionContext,
): Omit<SessionExtensionContext, "deps" | "onStop"> {
  const rootDir = getSlateAgentsRootDir();
  const requestContext = createContext().with(loggerKey, { log: () => {} });
  const storeFactory = createSessionStoreFactory({
    rootDir,
    context: requestContext,
    report: hostContext.deps.telemetry.logs.reportSessionDiagnostic,
  });

  return {
    rootDir,
    getTranscriptsDir: getSlateTranscriptsDir,
    createStore: storeFactory,
    createHandoffDeps(): BoxHandoffDeps {
      return createSessionProductionHandoffDependencies({
        box: hostContext.deps["forever-box"].box,
        context: requestContext,
        events: hostContext.host.events,
        telemetry: {
          reportBoxHelp: event => hostContext.deps.telemetry.logs.reportBoxHelp(event),
          trackEvent: (name, properties) => hostContext.deps.telemetry.analytics.trackEvent(name, properties),
        },
      });
    },
  };
}
