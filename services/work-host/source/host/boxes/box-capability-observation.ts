import type { BoxCapabilityPort } from "./box-capability-contracts.ts";

export function windowCapacity(box: BoxCapabilityPort): number {
  return box.maxWindows?.() ?? 1;
}

export function supportsMultipleWindows(box: BoxCapabilityPort): boolean {
  return windowCapacity(box) > 1;
}

export function assignedWindowForAgent(
  box: BoxCapabilityPort,
  agentId: string,
): number | undefined {
  return box.getAgentWindowIndex?.(agentId);
}

export function terminalRootForBox(box: BoxCapabilityPort): string | undefined {
  return box.getTerminalsFolder?.();
}

export async function boxCanServeRequests(box: BoxCapabilityPort): Promise<boolean> {
  return box.isAvailable == null ? true : box.isAvailable();
}

export function isAgentPreparationActive(
  box: BoxCapabilityPort,
  agentId: string,
): boolean {
  return box.isPreparing?.(agentId) ?? false;
}

export function describeBoxCapability(box: BoxCapabilityPort): unknown {
  return box.describe?.();
}
