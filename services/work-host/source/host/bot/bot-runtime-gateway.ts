/**
 * The Bot runtime commands the application BFF calls.
 *
 * The gateway is a thin command adapter over the Bot box port. It validates
 * the wire arguments, keeps worker credentials on the host, and returns only
 * the desktop capability the surface needs.
 */
import type { BotRuntimeBinding } from "./bot-runtime-store.ts";
import { BotRuntimeStore } from "./bot-runtime-store.ts";
import { createSubstrateBotBoxProvider, type BotBoxProvider } from "./bot-box-provider.ts";
import {
  BotSubstrateError,
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

function bindingPayload(binding: BotRuntimeBinding): Record<string, unknown> {
  return {
    ok: true,
    state: "running",
    boxKey: binding.boxKey,
    sandboxId: binding.sandboxId,
    desktopUrl: binding.desktopUrl,
    vncUrl: binding.vncUrl,
  };
}

export function createBotRuntimeGateway(store: BotRuntimeStore): BotRuntimeGateway {
  return createBotRuntimeGatewayWithProvider(createSubstrateBotBoxProvider(store));
}

export function createBotRuntimeGatewayWithProvider(provider: BotBoxProvider): BotRuntimeGateway {
  return {
    async ensure(args: unknown) {
      const body = recordOf(args, "Bot runtime ensure");
      const endpoint = await provider.ensure({
        agentId: textOf(body, "agentId"),
        botId: textOf(body, "botId"),
        projectId: textOf(body, "projectId"),
        userId: textOf(body, "userId"),
        workspaceId: textOf(body, "workspaceId"),
        runtimeConfiguration: runtimeConfigurationOf(body.runtimeConfiguration),
        ...(body.nativeSession === undefined ? {} : { nativeSession: body.nativeSession as { header: Record<string, unknown>; entries: ReadonlyArray<Record<string, unknown>> } }),
        agent: "pi",
        accessMode: "restricted",
      });
      return {
        ok: true,
        boxKey: endpoint.boxKey,
        sandboxId: endpoint.sandboxId,
        desktopUrl: endpoint.desktopUrl,
        vncUrl: endpoint.vncUrl,
      };
    },

    async status(args: unknown) {
      const body = recordOf(args, "Bot runtime status");
      const status = await provider.status(textOf(body, "agentId"));
      return status.binding === null ? { ok: true, state: "absent" } : bindingPayload(status.binding);
    },

    async release(args: unknown) {
      const body = recordOf(args, "Bot runtime release");
      return { ok: true, released: await provider.release(textOf(body, "agentId")) };
    },

    async respondExtensionUi(args: unknown) {
      const body = recordOf(args, "Bot extension response");
      const agentId = textOf(body, "agentId");
      const binding = provider.readBinding(agentId);
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
      return provider.readBinding(agentId);
    },
  };
}
