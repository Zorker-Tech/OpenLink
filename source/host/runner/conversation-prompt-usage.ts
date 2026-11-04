import { sanitizeExtendedUsage, sanitizeUsage } from "./conversation-usage.ts";

export async function* sanitizeFullStream(stream: AsyncIterable<any>): AsyncIterable<any> {
  let pendingError: unknown;
  for await (const part of stream) {
    if (pendingError != null) continue;
    if (part.type === "error") {
      pendingError = part.error instanceof Error ? part.error : new Error(String(part.error));
      continue;
    }
    yield part.type === "finish" ? { ...part, usage: sanitizeUsage(part.usage) } : part;
  }
  if (pendingError != null) throw pendingError;
}

export function sanitizeStreamResult<T extends {
  fullStream: AsyncIterable<any>;
  response: Promise<{ modelId: string }>;
  usage: Promise<Record<string, unknown>>;
  extendedUsage: Promise<Record<string, unknown>>;
}>(result: T, modelId: string, onResolvedModelId?: (modelId: string) => void) {
  return {
    ...result,
    fullStream: sanitizeFullStream(result.fullStream),
    response: result.response.then((response) => {
      const resolvedModelId = response.modelId.trim();
      if (resolvedModelId) onResolvedModelId?.(resolvedModelId);
      return response;
    }),
    usage: result.usage.then(sanitizeUsage),
    extendedUsage: result.extendedUsage.then((usage) => sanitizeExtendedUsage(usage, modelId)),
  };
}

export function createSlateResolvedModelTracker() {
  let requestOrdinal = 0;
  const acceptedModels = new Map<string, { requestOrdinal: number; modelId: string }>();
  return {
    get: (requestedModelId: string) => acceptedModels.get(requestedModelId)?.modelId,
    beginRequest: (requestedModelId: string) => {
      const requestSequence = ++requestOrdinal;
      return (resolvedModelId: string): boolean => {
        const previous = acceptedModels.get(requestedModelId);
        if (previous != null && previous.requestOrdinal >= requestSequence) return false;
        acceptedModels.set(requestedModelId, { requestOrdinal: requestSequence, modelId: resolvedModelId });
        return true;
      };
    },
  };
}

export function sanitizePromptExecutorUsage<T extends { stream(...args: any[]): any }>(
  executor: T,
  modelId: string,
  tracking?: { tracker: ReturnType<typeof createSlateResolvedModelTracker>; onResolvedModelId(modelId: string): void },
): T {
  return new Proxy(executor, {
    get(target, property, receiver) {
      if (property !== "stream") return Reflect.get(target, property, receiver);
      return (...args: any[]) => {
        const accept = tracking?.tracker.beginRequest(modelId);
        return sanitizeStreamResult(target.stream(...args), modelId, (resolvedModelId) => {
          if (accept?.(resolvedModelId) === true) tracking?.onResolvedModelId(resolvedModelId);
        });
      };
    },
  });
}

export function sanitizePromptSessionUsage<T>(
  session: { getExecutor(state: unknown): T; getModelId(): string },
  tracker = createSlateResolvedModelTracker(),
  onResolvedModelId?: (modelId: string) => void,
) {
  let resolvedModelId = tracker.get(session.getModelId());
  const wrapTracked = (state: unknown) => sanitizePromptExecutorUsage(
    session.getExecutor(state) as T & { stream(...args: any[]): any },
    session.getModelId(),
    { tracker, onResolvedModelId: (value) => { resolvedModelId = value; onResolvedModelId?.(value); } },
  );
  const wrapUntracked = (state: unknown) => sanitizePromptExecutorUsage(
    session.getExecutor(state) as T & { stream(...args: any[]): any },
    session.getModelId(),
  );
  return {
    getExecutor: wrapTracked,
    getExecutorWithoutResolvedModelTracking: wrapUntracked,
    getModelId: () => session.getModelId(),
    getResolvedModelId: () => resolvedModelId,
  };
}
