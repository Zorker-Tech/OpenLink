import {
  SLATE_BOX_NAMESPACE_HEADER,
  SLATE_CLIENT_TYPE,
  getBoxNamespace,
  getSlateClientVersion,
} from "../../../shared/node/slate-client-metadata.ts"

/** Translate Slate-owned build identity into the headers the connected service expects. */
export function getSlateBackendClientHeaders(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const namespace = getBoxNamespace(env)
  return {
    "x-cursor-client-type": SLATE_CLIENT_TYPE,
    "x-cursor-client-version": getSlateClientVersion(env),
    [SLATE_BOX_NAMESPACE_HEADER]: namespace,
  }
}
