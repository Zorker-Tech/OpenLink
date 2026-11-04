/** Configuration shared by the handlers that create and run agent tools. */

import type { InteropAgentConfigRule } from "../../adapters/interop/agent/agent-config-tooling-adapter.ts";
import type { AgentToolsGenerator, AgentToolsGeneratorInput } from "./tools/tools-generator.ts";

type SharedToolGenerationSettings = Pick<
  AgentToolsGeneratorInput,
  | "agentSessionId"
  | "autoRejectFirstAskQuestion"
  | "smartModeClassifierMode"
  | "smartModeClassifierShadowMode"
>;

interface AgentToolFeatureFlags {
  readonly writeBarrierTimeoutMs?: number | undefined;
  readonly nalLoopDetection?: boolean | undefined;
  readonly dropCustomPromptContext?: boolean | undefined;
  readonly enableHookAdditionalContext?: boolean | undefined;
  readonly enableAgentStoreConflictNotices?: boolean | undefined;
}

export interface AgentConfigTooling extends SharedToolGenerationSettings {
  readonly toolsGenerator: AgentToolsGenerator;
  readonly enableToolArgPreservation: boolean | undefined;
  readonly featureFlags: AgentToolFeatureFlags | undefined;
  readonly recordAgentStoreWriteBarrier: unknown;
  readonly nonFileRules: readonly InteropAgentConfigRule[];
}
