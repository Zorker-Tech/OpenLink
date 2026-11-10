import { createKey } from "../context/context.ts";

function optionalHookContextKey<Value>(symbolName: string) {
  return createKey<Value | undefined>(Symbol(symbolName), undefined);
}

export const execHookConversationIdKey = optionalHookContextKey<string>("execHookConversationId");
export const execHookGenerationIdKey = optionalHookContextKey<string>("execHookGenerationId");
export const execHookModelKey = optionalHookContextKey<string>("execHookModel");
export const execHookWorkspaceRootsKey = optionalHookContextKey<readonly string[]>("execHookWorkspaceRoots");
