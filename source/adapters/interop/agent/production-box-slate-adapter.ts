/** Production box ports built directly on Slate's control and execution protocols. */
import {
  createProductionBoxAccessPolicies,
  type ProductionGeneratedBoxAccessor,
} from "../../../host/boxes/production-box-access-policies.ts";
import type {
  ProductionBoxControlClient,
  ProductionBoxGeneratedPorts,
} from "../../../host/boxes/production.ts";
import type {
  BoxPingControlClient,
  BoxRemoteExecClient,
  BoxTransportFactory,
  BoxTransportOptions,
} from "../../../host/boxes/box-remote-accessor.ts";
import type { BoxEnvironmentControlClient } from "../../../host/boxes/box-environment-control.ts";
import type { BoxMcpPort } from "../../../host/boxes/box-mcp.ts";
import { createSlateBoxControlClient } from "../box/slate-box-control-client.ts";
import { createSlateBoxExecClient } from "../box/slate-box-exec-client.ts";
import { createSlateBoxRemoteExecClient } from "../box/box-exec-wire-adapter.ts";

export const SLATE_BOX_PROTOCOL_VERSION = 1 as const;

interface NativeRequest {
  readonly header: { set(name: string, value: string): void };
}

export interface SlateBoxTransport {
  readonly kind: "slate-box-transport";
  readonly baseUrl: string;
  readonly interceptors: BoxTransportOptions["interceptors"];
}

function createTransport(options: BoxTransportOptions): SlateBoxTransport {
  return Object.freeze({
    kind: "slate-box-transport" as const,
    baseUrl: options.baseUrl,
    interceptors: options.interceptors,
  });
}

function makePorts(
  fetcher: typeof fetch,
): ProductionBoxGeneratedPorts<SlateBoxTransport, ProductionGeneratedBoxAccessor> {
  const accessorPolicies = createProductionBoxAccessPolicies();
  return {
    createTransport: createTransport as BoxTransportFactory<SlateBoxTransport>,
    createControlClient(transport): ProductionBoxControlClient {
      const client = createSlateBoxControlClient<NativeRequest>(transport, fetcher);
      const ping = async (ctx: Parameters<BoxPingControlClient["ping"]>[0], request: Parameters<BoxPingControlClient["ping"]>[1], options: Parameters<BoxPingControlClient["ping"]>[2]) =>
        await client.ping(ctx, request as Readonly<Record<string, never>>, options);
      const updateEnvironmentVariables = async (
        ctx: Parameters<BoxEnvironmentControlClient["updateEnvironmentVariables"]>[0],
        request: Parameters<BoxEnvironmentControlClient["updateEnvironmentVariables"]>[1],
      ) => await client.updateEnvironmentVariables(ctx, request);
      const loadServers = async (
        ctx: Parameters<BoxMcpPort["loadServers"]>[0],
        config: string,
      ) => (await client.loadMcpServers(ctx, { mcpConfigJson: config })).loadedServerNames;
      return { ping, updateEnvironmentVariables, loadServers };
    },
    createExecClient(transport): BoxRemoteExecClient {
      return createSlateBoxRemoteExecClient(createSlateBoxExecClient(transport, fetcher));
    },
    ...accessorPolicies,
  };
}

export function createProductionSlateBoxPorts(
  _legacyBindings?: unknown,
  fetcher: typeof fetch = fetch,
): ProductionBoxGeneratedPorts<SlateBoxTransport, ProductionGeneratedBoxAccessor> {
  return makePorts(fetcher);
}

export const productionSlateBoxPorts = makePorts(fetch);

/** Compatibility aliases for callers that landed before the production box ports became Slate-native. */
export const BOX_GENERATED_PACKAGE_VERSIONS = Object.freeze({
  protobuf: "1.10.1",
  connect: "1.6.1",
  connectNode: "1.6.1",
} as const);
export const createProductionBoxGeneratedPorts = createProductionSlateBoxPorts;
export const productionBoxGeneratedPorts = productionSlateBoxPorts;
