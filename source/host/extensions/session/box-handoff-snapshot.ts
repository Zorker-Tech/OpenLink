import {
  SNAPSHOT_TIMEOUT_MS,
  type BoxHandoffDeps,
  type HandoffRequest,
} from "./box-handoff-contracts.ts";
import { reportHandoffCapture } from "./box-handoff-telemetry.ts";

type Screenshot = string | Uint8Array | null;

function asWebpDataUrl(screenshot: Exclude<Screenshot, null>): string {
  const encoded = typeof screenshot === "string"
    ? screenshot
    : Buffer.from(screenshot).toString("base64");
  return `data:image/webp;base64,${encoded}`;
}

function captureWithinBudget(
  deps: BoxHandoffDeps,
  agentId: string,
): Promise<Screenshot> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), deps.timeoutMs ?? SNAPSHOT_TIMEOUT_MS);
    timer.unref();
  });
  let screenshot: Promise<Screenshot>;
  try {
    screenshot = deps.grabScreenshot?.(agentId) ?? Promise.resolve(null);
  } catch (error) {
    if (timer !== undefined) clearTimeout(timer);
    throw error;
  }
  return Promise.race([screenshot, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export async function captureHandoffSnapshot(
  deps: BoxHandoffDeps,
  request: HandoffRequest,
  requestId: string,
  isCurrent: (agentId: string, requestId: string) => boolean,
  store: (agentId: string, requestId: string, snapshotDataUrl: string) => void,
): Promise<void> {
  let captured = false;
  try {
    await deps.prepare?.(request.agentId, request as unknown as Record<string, unknown>);
    const screenshot = await captureWithinBudget(deps, request.agentId);
    if (screenshot !== null && screenshot.length > 0 && isCurrent(request.agentId, requestId)) {
      captured = true;
      store(request.agentId, requestId, asWebpDataUrl(screenshot));
    }
  } catch {
    // Snapshot support must never prevent the handoff itself from finishing.
  }

  reportHandoffCapture(deps, request, captured);
}
