import { BoxEnvironmentSyncUnsupportedError, BoxMcpUnsupportedError } from "../ports/box.ts";
import type { Context } from "../../packages/context/context.ts";
import type { BoxCapabilityPort } from "./box-capability-contracts.ts";

export async function applyBoxEnvironment(
  box: BoxCapabilityPort,
  context: Context,
  update: unknown,
): Promise<void> {
  if (box.applyEnvironment == null) throw new BoxEnvironmentSyncUnsupportedError();
  await box.applyEnvironment(context, update);
}

export async function loadBoxMcpConfiguration(
  box: BoxCapabilityPort,
  context: Context,
  configJson: string,
): Promise<unknown> {
  if (box.loadMcpServers == null) throw new BoxMcpUnsupportedError();
  return box.loadMcpServers(context, configJson);
}

export async function boxMcpResources(
  box: BoxCapabilityPort,
  context: Context,
): Promise<unknown> {
  if (box.mcpResourceAccessor == null) throw new BoxMcpUnsupportedError();
  return box.mcpResourceAccessor(context);
}
