/**
 * The part of an agent's configuration that tool generation consumes.
 *
 * Tools are built from the session's own facts — which generator to use, the session id, whether the
 * first question should be auto-rejected, the classifier's two modes, the feature flags that change what
 * a tool does, the write barrier the store reports, and the rules that are not about files. The shape
 * belongs to the configuration owner rather than to whichever handler happens to pass it along, so it is
 * declared here: a handler-local shape would drift the moment a second caller needs it.
 */

import type { AgentToolsGenerator } from "./tools/tools-generator.ts"
import type { CursorRule } from "../proto/generated/agent/v1/rules_pb.ts"

export interface AgentConfigTooling {
  readonly toolsGenerator: AgentToolsGenerator
  readonly agentSessionId: string | undefined
  readonly autoRejectFirstAskQuestion: boolean | undefined
  readonly smartModeClassifierMode: boolean | undefined
  readonly smartModeClassifierShadowMode: boolean | undefined
  readonly enableToolArgPreservation: boolean | undefined
  readonly featureFlags: {
    readonly writeBarrierTimeoutMs?: number | undefined
    readonly nalLoopDetection?: boolean | undefined
    readonly dropCustomPromptContext?: boolean | undefined
    readonly enableHookAdditionalContext?: boolean | undefined
    readonly enableAgentStoreConflictNotices?: boolean | undefined
  } | undefined
  readonly recordAgentStoreWriteBarrier: unknown
  readonly nonFileRules: readonly CursorRule[]
}
