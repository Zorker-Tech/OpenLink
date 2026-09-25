/**
 * What a hook is told about the call it is answering, carried on the context rather than in the request.
 *
 * A hook runs on the host side of the exec channel, so the facts it needs about the turn — which conversation, which generation, which model, which workspace roots — travel beside the request on the context rather than being restated in every message. They are keys rather than fields for that reason: a hook reads them from wherever it runs, and a request that does not carry them simply does not have them.
 */

import { createKey } from "../context/context.ts";
export const execHookConversationIdKey = createKey<string | undefined>(Symbol("execHookConversationId"), undefined);
export const execHookGenerationIdKey = createKey<string | undefined>(Symbol("execHookGenerationId"), undefined);
export const execHookModelKey = createKey<string | undefined>(Symbol("execHookModel"), undefined);
export const execHookWorkspaceRootsKey = createKey<readonly string[] | undefined>(Symbol("execHookWorkspaceRoots"), undefined);
