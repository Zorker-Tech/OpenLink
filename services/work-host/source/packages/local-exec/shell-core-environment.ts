import { join } from "node:path";
import type { Context } from "../context/context.ts";
import { getSafeConversationId, TRANSCRIPTS_SUBDIR } from "../utils/conversation-paths.ts";
import type { ShellCoreArgs } from "./shell-core-contracts.ts";

const REQUEST_SCOPED_ENV_KEYS = ["SLATE_CONVERSATION_ID", "SLATE_AGENT_STORE_FILES_DIR", "SLATE_AGENT_STORE_SHARED_PATHS"] as const;

function shellQuoted(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function effectiveEnvironmentValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  return env[key] ?? process.env[key];
}

function appendRequestEnvironmentRestore(env: NodeJS.ProcessEnv): void {
  const restoreSteps = [`builtin unset ${REQUEST_SCOPED_ENV_KEYS.join(" ")} 2>/dev/null || true`];
  for (const key of REQUEST_SCOPED_ENV_KEYS) {
    const value = effectiveEnvironmentValue(env, key);
    if (value !== undefined) restoreSteps.push(`builtin export ${key}=${shellQuoted(value)}`);
  }

  env.__SLATE_SANDBOX_ENV_RESTORE = [
    process.env.__SLATE_SANDBOX_ENV_RESTORE?.trim(),
    env.__SLATE_SANDBOX_ENV_RESTORE?.trim(),
    restoreSteps.join("; "),
  ].filter((step) => step !== undefined && step !== "").join("; ");
}

/** Build a command-scoped environment, preserving and then restoring values that must not leak to later runs. */
export function createShellCoreEnvironment(
  ctx: Context,
  args: ShellCoreArgs,
  projectDir: string | undefined,
  extraEnvProvider: ((ctx: Context, args: ShellCoreArgs) => NodeJS.ProcessEnv | undefined) | undefined,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { SLATE_AGENT: "1" };
  if (args.conversationId) env.SLATE_CONVERSATION_ID = getSafeConversationId(args.conversationId);
  if (projectDir) env.SLATE_AGENT_TRANSCRIPTS = join(projectDir, TRANSCRIPTS_SUBDIR);

  Object.assign(env, extraEnvProvider?.(ctx, args));
  appendRequestEnvironmentRestore(env);

  return env;
}

/** Add the prompt bridge only after the sandbox start event has been delivered. */
export function addAskpassEnvironment(env: NodeJS.ProcessEnv, args: ShellCoreArgs): void {
  if (args.askpassConfig === undefined || process.platform === "win32") return;
  env.SUDO_ASKPASS = args.askpassConfig.helperPath;
  env.SLATE_ASKPASS_SOCKET = args.askpassConfig.socketPath;
  env.SLATE_ASKPASS_SECRET = args.askpassConfig.secret;
}
