import type { Context } from "../../packages/context/context.ts"
import type { BoxEnvironmentUpdate } from "./box-env.ts"

export interface BoxEnvironmentControlClient {
  updateEnvironmentVariables(
    ctx: Context,
    request: { readonly env: Record<string, string>; readonly replace: boolean },
  ): Promise<unknown>
}

export async function applyBoxEnvironmentViaTransport<Transport>(
  ctx: Context,
  transport: Transport,
  update: BoxEnvironmentUpdate,
  createClient: (transport: Transport) => BoxEnvironmentControlClient,
): Promise<void> {
  const client = createClient(transport)
  await client.updateEnvironmentVariables(ctx, {
    env: { ...update.env },
    replace: update.replace,
  })
}
