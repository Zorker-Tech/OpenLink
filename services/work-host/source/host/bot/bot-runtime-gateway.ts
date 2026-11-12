/**
 * The Bot runtime commands the application BFF calls.
 *
 * The gateway is the only place where a Bot's application identity is joined
 * to its execution substrate. It stores the binding, keeps worker credentials
 * on the host, and exposes only the desktop URL to callers.
 */
import type { BotRuntimeBinding } from "./bot-runtime-store.ts";
import { BotRuntimeStore } from "./bot-runtime-store.ts";
import {
  BotSubstrateError,
  ensureBotSubstrate,
  releaseBotSubstrate,
  respondBotWorkerExtensionUi,
  type BotSubstrateRuntimeConfiguration,
} from "./substrate-client.ts";

export interface BotRuntimeGateway {
  ensure(args: unknown): Promise<Record<string, unknown>>;
  status(args: unknown): Promise<Record<string, unknown>>;
  release(args: unknown): Promise<Record<string, unknown>>;
  respondExtensionUi(args: unknown): Promise<Record<string, unknown>>;
  readBinding(agentId: string): BotRuntimeBinding | null;
}

function recordOf(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new BotSubstrateError(`${label} is invalid`, 400, "BOT_RUNTIME_ARGS_INVALID", false);
  }
  return value as Record<string, unknown>;
}

function textOf(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new BotSubstrateError(`${name} is invalid`, 400, "BOT_RUNTIME_ARGS_INVALID", false);
  }
  return value;
}

function runtimeConfigurationOf(value: unknown): BotSubstrateRuntimeConfiguration {
  const record = recordOf(value, "runtimeConfiguration");
  return {
    providerId: textOf(record, "providerId"),
    modelId: textOf(record, "modelId"),
    apiKey: textOf(record, "apiKey"),
    baseUrl: textOf(record, "baseUrl"),
    revision: textOf(record, "revision"),
  };
}

function bindingFrom(
  agentId: string,
  botId: string,
  projectId: string,
  userId: string,
  workspaceId: string,
  payload: { boxKey: string; sandboxId: string | null; workerUrl: string | null; workerHeaders: Readonly<Record<string, string>>; desktopUrl: string; vncUrl: string },
): BotRuntimeBinding {
  if (payload.workerUrl === null) {
    throw new BotSubstrateError("Bot substrate did not return a worker endpoint", 502, "BOT_WORKER_UNAVAILABLE", true);
  }
  return {
    version: 1,
    agentId,
    botId,
    boxKey: payload.boxKey,
    projectId,
    userId,
    workspaceId,
    workerUrl: payload.workerUrl,
    workerHeaders: payload.workerHeaders,
    desktopUrl: payload.desktopUrl,
    vncUrl: payload.vncUrl,
    sandboxId: payload.sandboxId,
    updatedAt: new Date().toISOString(),
  };
}

export function createBotRuntimeGateway(store: BotRuntimeStore): BotRuntimeGateway {
  return {
    async ensure(args: unknown) {
      const body = recordOf(args, "Bot runtime ensure");
      const agentId = textOf(body, "agentId");
      const botId = textOf(body, "botId");
      const projectId = textOf(body, "projectId");
      const userId = textOf(body, "userId");
      const workspaceId = textOf(body, "workspaceId");
      const payload = await ensureBotSubstrate({
        botId,
        projectId,
        userId,
        workspaceId,
        runtimeConfiguration: runtimeConfigurationOf(body.runtimeConfiguration),
        ...(body.nativeSession === undefined ? {} : { nativeSession: body.nativeSession as { header: Record<string, unknown>; entries: ReadonlyArray<Record<string, unknown>> } }),
        agent: "pi",
        accessMode: "restricted",
      });
      const binding = bindingFrom(agentId, botId, projectId, userId, workspaceId, payload);
      store.write(binding);
      return {
        ok: true,
        boxKey: binding.boxKey,
        sandboxId: binding.sandboxId,
        desktopUrl: binding.desktopUrl,
        vncUrl: binding.vncUrl,
      };
    },

    async status(args: unknown) {
      const body = recordOf(args, "Bot runtime status");
      const agentId = textOf(body, "agentId");
      const binding = store.read(agentId);
      if (binding === null) return { ok: true, state: "absent" };
      return {
        ok: true,
        state: "running",
        boxKey: binding.boxKey,
        sandboxId: binding.sandboxId,
        desktopUrl: binding.desktopUrl,
        vncUrl: binding.vncUrl,
      };
    },

    async release(args: unknown) {
      const body = recordOf(args, "Bot runtime release");
      const agentId = textOf(body, "agentId");
      const binding = store.read(agentId);
      if (binding !== null) {
        await releaseBotSubstrate({ botId: binding.botId, userId: binding.userId, workspaceId: binding.workspaceId });
        store.remove(agentId);
      }
      return { ok: true, released: binding !== null };
    },

    async respondExtensionUi(args: unknown) {
      const body = recordOf(args, "Bot extension response");
      const agentId = textOf(body, "agentId");
      const binding = store.read(agentId);
      if (binding === null) throw new BotSubstrateError("Bot runtime is not provisioned", 409, "BOT_RUNTIME_NOT_READY", true);
      const id = textOf(body, "id");
      const confirmed = body.confirmed;
      const value = body.value;
      const cancelled = body.cancelled;
      if (confirmed !== undefined && typeof confirmed !== "boolean") throw new BotSubstrateError("confirmed is invalid", 400, "BOT_RUNTIME_ARGS_INVALID", false);
      if (value !== undefined && (typeof value !== "string" || value.length > 100_000)) throw new BotSubstrateError("value is invalid", 400, "BOT_RUNTIME_ARGS_INVALID", false);
      if (cancelled !== undefined && cancelled !== true) throw new BotSubstrateError("cancelled is invalid", 400, "BOT_RUNTIME_ARGS_INVALID", false);
      await respondBotWorkerExtensionUi(binding, {
        id,
        ...(confirmed === undefined ? {} : { confirmed }),
        ...(value === undefined ? {} : { value }),
        ...(cancelled === true ? { cancelled: true as const } : {}),
      });
      return { ok: true };
    },

    readBinding(agentId: string) {
      return store.read(agentId);
    },
  };
}
