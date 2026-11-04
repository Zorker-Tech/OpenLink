import { currentHostTraceFactory } from "./send-trace-registry.ts";
import type { HostTrace } from "./send-trace-contracts.ts";

export async function traceSendPhase<T>(
  context: HostTrace | undefined,
  name: string,
  run: (context: HostTrace | undefined) => Promise<T>,
): Promise<T> {
  const factory = currentHostTraceFactory();
  if (context == null || factory == null) return run(context);

  let child: HostTrace | undefined;
  try {
    child = factory({ name, parentCtx: context.context });
  } catch {
    return run(context);
  }
  if (child == null) return run(context);

  try {
    return await run(child);
  } catch (error) {
    try {
      child.span.recordException(error instanceof Error ? error : new Error(String(error)));
      child.span.setStatus({ code: 2 });
    } catch {
      // Preserve the operation error if the span itself cannot report it.
    }
    throw error;
  } finally {
    try {
      child.span.end();
    } catch {
      // Ending a child span is best-effort.
    }
  }
}
