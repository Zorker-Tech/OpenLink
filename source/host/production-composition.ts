/** The one production composition root for the host process. */
import { createDefaultProductionTranscriptMirrorProvider } from "../adapters/interop/agent/production-transcript-mirror-adapter.ts";
import { executeBoxCopyInFromEnv } from "./boxes/box-store-sync/box-copy-in.ts";
import { productionSlateBoxPorts } from "./boxes/slate-production.ts";
import { bindRecoveredProductionExtensions } from "./host-production-extensions.ts";
import { productionLocalExecCodec } from "./local-exec/production.ts";
import {
  convertProductionCloudAgentConversationToTrace,
  createProductionStateBackstop,
  productionSecretsContext,
} from "./production-binding-providers.ts";
import { createRunnerContext } from "./runner-context-production-provider.ts";
import type { HostProductionPorts } from "./main.ts";

/** Bind the local providers and protocol adapters the host's declared extension graph requires. */
export function createProductionHostPorts(): HostProductionPorts {
  return bindRecoveredProductionExtensions({
    extensionHost: {
      boxGenerated: productionSlateBoxPorts,
      convertCloudAgentConversationToTrace: convertProductionCloudAgentConversationToTrace,
    },
    runnerContext: createRunnerContext(),
    createTranscriptMirror: createDefaultProductionTranscriptMirrorProvider(),
    executeBoxCopyInFromEnv,
  }, {
    stateBackstop: createProductionStateBackstop(),
    localExecCodec: productionLocalExecCodec,
    secretsContext: productionSecretsContext,
  });
}
