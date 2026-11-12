/**
 * The Bot box port.
 *
 * One Bot owns one OpenSandbox inside the Project VM. The provider is the only
 * component that joins a Bot's durable binding to the shared substrate, and it
 * keeps worker credentials on the host. Callers receive a desktop capability,
 * never the worker token.
 */
import type { BotRuntimeBinding } from "./bot-runtime-store.ts";
import { BotRuntimeStore } from "./bot-runtime-store.ts";
import {
  BotSubstrateError,
  ensureBotSubstrate,
  getBotSubstrateDesktop,
  releaseBotSubstrate,
  type BotSubstrateEnsureInput,
  type BotSubstratePayload,
  type BotSubstrateRuntimeConfiguration,
} from "./substrate-client.ts";

export interface BotBoxEndpoint {
  readonly boxKey: string;
  readonly sandboxId: string | null;
  readonly desktopUrl: string;
  readonly vncUrl: string;
}

export interface BotBoxStatus {
  readonly state: "absent" | "running";
  readonly binding: BotRuntimeBinding | null;
}

export interface BotBoxProvider {
  ensure(input: BotSubstrateEnsureInput & { readonly agentId: string }): Promise<BotBoxEndpoint>;
  status(agentId: string): Promise<BotBoxStatus>;
  desktop(input: BotSubstrateEnsureInput & { readonly agentId: string }): Promise<BotBoxEndpoint>;
  release(agentId: string): Promise<boolean>;
  readBinding(agentId: string): BotRuntimeBinding | null;
}

function bindingFrom(
  agentId: string,
  input: BotSubstrateEnsureInput,
  payload: BotSubstratePayload,
): BotRuntimeBinding {
  if (payload.workerUrl === null) {
    throw new BotSubstrateError("Bot substrate did not return a worker endpoint", 502, "BOT_WORKER_UNAVAILABLE", true);
  }
  return {
    version: 1,
    agentId,
    botId: input.botId,
    boxKey: payload.boxKey,
    projectId: input.projectId,
    userId: input.userId,
    workspaceId: input.workspaceId,
    workerUrl: payload.workerUrl,
    workerHeaders: payload.workerHeaders,
    desktopUrl: payload.desktopUrl,
    vncUrl: payload.vncUrl,
    sandboxId: payload.sandboxId,
    updatedAt: new Date().toISOString(),
  };
}

function endpointOf(binding: BotRuntimeBinding): BotBoxEndpoint {
  return {
    boxKey: binding.boxKey,
    sandboxId: binding.sandboxId,
    desktopUrl: binding.desktopUrl,
    vncUrl: binding.vncUrl,
  };
}

export function createSubstrateBotBoxProvider(store: BotRuntimeStore): BotBoxProvider {
  return {
    async ensure(input) {
      const payload = await ensureBotSubstrate(input);
      const binding = bindingFrom(input.agentId, input, payload);
      store.write(binding);
      return endpointOf(binding);
    },

    async status(agentId) {
      const binding = store.read(agentId);
      return binding === null
        ? { state: "absent", binding: null }
        : { state: "running", binding };
    },

    async desktop(input) {
      // A desktop request is a wake-up, not just a read: the substrate
      // resumes a paused sandbox before it returns the capability URL.
      const payload = await getBotSubstrateDesktop(input);
      const binding = bindingFrom(input.agentId, input, payload);
      store.write(binding);
      return endpointOf(binding);
    },

    async release(agentId) {
      const binding = store.read(agentId);
      if (binding === null) return false;
      await releaseBotSubstrate({ botId: binding.botId, userId: binding.userId, workspaceId: binding.workspaceId });
      store.remove(agentId);
      return true;
    },

    readBinding(agentId) {
      return store.read(agentId);
    },
  };
}

export type { BotSubstrateRuntimeConfiguration };
