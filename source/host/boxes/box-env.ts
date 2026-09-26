/** Setting the environment of a box through the control connection it was opened over. */
import type { Context } from "../../packages/context/context.ts";

export interface BoxEnvironmentUpdate { env: Readonly<Record<string, string>>; replace: boolean }
export interface BoxEnvironmentControlClient { updateEnvironmentVariables(ctx: Context, request: { env: Record<string, string>; replace: boolean }): Promise<unknown> }
export async function applyBoxEnvironmentViaTransport<Transport>(ctx: Context, transport: Transport, update: BoxEnvironmentUpdate, createClient: (transport: Transport) => BoxEnvironmentControlClient): Promise<void> { const control = createClient(transport); await control.updateEnvironmentVariables(ctx, { env: { ...update.env }, replace: update.replace }); }
