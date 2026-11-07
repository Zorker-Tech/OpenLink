/** Binds the navigation probe to generated shell requests and projects only its output fields. */

import { requestIdKey } from "../chat-inference-proto/client.ts"
import { shellExecutorResource, type ShellExecutor } from "../../../packages/agent-exec/shell.ts"
import type { Context } from "../../../packages/context/context.ts"
import { buildHostShellArgs } from "../../../host/boxes/box-shell-command.ts"
import type { HostShellArgsInput } from "../../../host/boxes/box-shell-command.ts"

export type NavigationProbeShellOutcome =
  | { readonly case: "success"; readonly stdout: string; readonly exitCode: number }
  | { readonly case: "failure" }

interface SlateShellResourceAccessor {
  get(resource: typeof shellExecutorResource): ShellExecutor
}

function isSlateShellResourceAccessor(value: unknown): value is SlateShellResourceAccessor {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "get") === "function"
}

function shellOutcomeForSlate(result: Awaited<ReturnType<ShellExecutor["execute"]>>): NavigationProbeShellOutcome {
  if (result.outcome.kind !== "success") return { case: "failure" }
  return {
    case: "success",
    stdout: result.outcome.stdout,
    exitCode: result.outcome.exitCode,
  }
}

/** Runs a probe through a generated resource accessor, returning undefined when there is no such accessor. */
export async function runNavigationProbeShellThroughInterop(
  context: unknown,
  remoteAccessor: unknown,
  input: HostShellArgsInput,
): Promise<NavigationProbeShellOutcome | undefined> {
  if (!isSlateShellResourceAccessor(remoteAccessor)) return undefined
  const result = await remoteAccessor.get(shellExecutorResource).execute(context as Context, buildHostShellArgs(input))
  return shellOutcomeForSlate(result)
}

/** Reads the request identifier stored by the inference transport without exposing its key to host policy. */
export function requestIdFromInteropContext(value: unknown): string | undefined {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return undefined
  const get = Reflect.get(value, "get")
  if (typeof get !== "function") return undefined
  const requestId: unknown = get.call(value, requestIdKey)
  return typeof requestId === "string" ? requestId : undefined
}
