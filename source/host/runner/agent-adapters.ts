/** Slate's stable host-runner adapter surface. Counterpart wire shapes are isolated under adapters/interop. */
export {
  deriveSlateSubagentRequestLineage,
  ForwardingInteractionListener,
  SlateRequestContextExecutor,
  SlateSubagentDispatchError,
  SlateSubagentHostAdapter,
} from "../../adapters/interop/agent/runner-agent-adapters.ts";
export type { ForwardedUpdate, ForwardingInteractionObservers } from "./forwarding-interaction-updates.ts";
export type { RequestContextProvider } from "./request-context-result.ts";
export type { SubagentAdapterArgs, SubagentDispatcher } from "./subagent-session-coordinator.ts";
