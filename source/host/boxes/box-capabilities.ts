/**
 * What a box can do, asked of the box when the question arises.
 *
 * Every capability is optional — a box that cannot open several windows simply has one, one that keeps no
 * terminals folder has none — so the host asks rather than assumes, and multi-window support is exactly "more than
 * one".
 */
export type { BoxCapabilityPort, CapableBox } from "./box-capability-contracts.ts";
export {
  assignedWindowForAgent as boxAgentWindowIndex,
  boxCanServeRequests as boxIsAvailable,
  describeBoxCapability as boxDescription,
  isAgentPreparationActive as boxIsPreparing,
  supportsMultipleWindows as boxSupportsMultiWindow,
  terminalRootForBox as boxTerminalsFolder,
  windowCapacity as boxMaxWindows,
} from "./box-capability-observation.ts";
export {
  applyBoxEnvironment as boxApplyEnvironment,
  boxMcpResources as boxMcpResourceAccessor,
  loadBoxMcpConfiguration as boxLoadMcpServers,
} from "./box-capability-operations.ts";
