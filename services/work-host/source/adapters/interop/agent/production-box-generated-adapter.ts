/** The generated pieces a box is built from, bound to this build's own package versions.

 * The service descriptors, the message constructors and the transport the box's calls run over are bound here, and the
 * two overlays a box needs — a read that is checked against what may be read, and computer use the box does not
 * monitor — are built on top of the accessor the box would otherwise have. */
import type { Transport } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import type { Context } from "../../../packages/context/context.ts";
import { createContextPropagatingClient } from "../../../packages/context-rpc/index.ts";
import {
  LoadMcpServersRequest,
  PingRequest,
  UpdateEnvironmentVariablesRequest
} from "../proto/generated/agent/v1/control_service_pb.ts";
import { ControlService } from "../proto/generated/agent/v1/control_service_connect.ts";
import { ExecService } from "../proto/generated/agent/v1/exec_service_connect.ts";
import type { BoxEnvironmentControlClient } from "./box-environment-transport-adapter.ts";
import { createProductionBoxAccessPolicies, type ProductionGeneratedBoxAccessor } from "../../../host/boxes/production-box-access-policies.ts";
import type { BoxMcpPort } from "../../../host/boxes/box-mcp.ts";
import type {
  BoxPingControlClient,
  BoxRemoteExecClient,
  BoxRemoteExecManager,
  BoxTransportFactory
} from "./box-remote-exec-accessor-adapter.ts";
import type {
  ProductionBoxControlClient,
  ProductionBoxGeneratedPorts
} from "../../../host/boxes/production.ts";
import {
  createSlateBoxControlClient,
  type SlateBoxControlTarget,
} from "../box/slate-box-control-client.ts";
import { createSlateBoxExecClient } from "../box/slate-box-exec-client.ts";
import { createSlateBoxRemoteExecClient } from "../box/box-exec-wire-adapter.ts";

/** The package versions this build binds its box's generated pieces to. */
export const BOX_GENERATED_PACKAGE_VERSIONS: Readonly<{
  protobuf: "1.10.1";
  connect: "1.6.1";
  connectNode: "1.6.1";
}> = Object.freeze({
  protobuf: "1.10.1",
  connect: "1.6.1",
  connectNode: "1.6.1"
});

export interface GeneratedMessageConstructor<Input, Message> {
  new(data?: Input): Message;
  readonly typeName: string;
  readonly fields: unknown;
}

export interface GeneratedServiceDescriptor<TypeName extends string> {
  readonly typeName: TypeName;
  readonly methods: Readonly<Record<string, unknown>>;
}

export interface GeneratedControlClient<
  PingRequest,
  UpdateEnvironmentVariablesRequest,
  LoadMcpServersRequest
> {
  ping(
    ctx: Context,
    request: PingRequest,
    options: { readonly timeoutMs: number }
  ): Promise<unknown>;
  updateEnvironmentVariables(
    ctx: Context,
    request: UpdateEnvironmentVariablesRequest
  ): Promise<unknown>;
  loadMcpServers(
    ctx: Context,
    request: LoadMcpServersRequest
  ): Promise<{ readonly loadedServerNames: string[] }>;
}

export interface GeneratedContextPropagatingClientFactory<
  Transport,
  PingRequest,
  UpdateEnvironmentVariablesRequest,
  LoadMcpServersRequest
> {
  (
    service: GeneratedServiceDescriptor<"agent.v1.ControlService">,
    transport: Transport
  ): GeneratedControlClient<
    PingRequest,
    UpdateEnvironmentVariablesRequest,
    LoadMcpServersRequest
  >;
  (
    service: GeneratedServiceDescriptor<"agent.v1.ExecService">,
    transport: Transport
  ): BoxRemoteExecClient;
}

export interface ProductionBoxGeneratedPackageBindings<
  Transport,
  PingRequest,
  UpdateEnvironmentVariablesRequest,
  LoadMcpServersRequest
> {
  readonly createConnectTransport: BoxTransportFactory<Transport>;
  readonly createContextPropagatingClient: GeneratedContextPropagatingClientFactory<
    Transport,
    PingRequest,
    UpdateEnvironmentVariablesRequest,
    LoadMcpServersRequest
  >;
  readonly controlService: GeneratedServiceDescriptor<"agent.v1.ControlService">;
  readonly execService: GeneratedServiceDescriptor<"agent.v1.ExecService">;
  readonly PingRequest: GeneratedMessageConstructor<
    Readonly<Record<string, never>>,
    PingRequest
  >;
  readonly UpdateEnvironmentVariablesRequest: GeneratedMessageConstructor<
    {
      readonly env: Readonly<Record<string, string>>;
      readonly replace: boolean;
    },
    UpdateEnvironmentVariablesRequest
  >;
  readonly LoadMcpServersRequest: GeneratedMessageConstructor<
    {
      readonly mcpConfigJson: string;
      readonly removeMissing: true;
    },
    LoadMcpServersRequest
  >;
}

/**
 * Builds the six ports a box is made of: the transport its calls run over, the control and exec clients, the resource
 * accessor, and the two overlays that check a read and take computer use out of the box's own hands.
 */
export function createProductionBoxGeneratedPorts<
  Transport,
  PingRequest,
  UpdateEnvironmentVariablesRequest,
  LoadMcpServersRequest
>(
  bindings: ProductionBoxGeneratedPackageBindings<
    Transport,
    PingRequest,
    UpdateEnvironmentVariablesRequest,
    LoadMcpServersRequest
  >,
  fetcher: typeof fetch = fetch,
): ProductionBoxGeneratedPorts<Transport, ProductionGeneratedBoxAccessor> {
  interface NativeRequest {
    readonly header: { set(name: string, value: string): void };
  }
  const nativeTargets = new WeakMap<object, SlateBoxControlTarget<NativeRequest>>();
  const accessorPolicies = createProductionBoxAccessPolicies();

  return {
    createTransport(options) {
      const transport = bindings.createConnectTransport(options);
      if (typeof transport !== "object" || transport === null) {
        throw new TypeError("box transport must be an object so its Slate control endpoint can be retained");
      }
      nativeTargets.set(transport, {
        baseUrl: options.baseUrl,
        interceptors: options.interceptors as unknown as SlateBoxControlTarget<NativeRequest>["interceptors"],
      });
      return transport;
    },

    createControlClient(transport): ProductionBoxControlClient {
      if (typeof transport !== "object" || transport === null) {
        throw new TypeError("box transport must be an object");
      }
      const target = nativeTargets.get(transport);
      if (target === undefined) throw new TypeError("box transport was not created by this production adapter");
      const client = createSlateBoxControlClient(target, fetcher);
      const ping: BoxPingControlClient["ping"] = async (ctx, _request, options) => await client.ping(ctx, {}, options);
      const updateEnvironmentVariables: BoxEnvironmentControlClient["updateEnvironmentVariables"] =
        async (ctx, request) => await client.updateEnvironmentVariables(ctx, request);
      const loadServers: BoxMcpPort["loadServers"] = async (ctx, config) =>
        (await client.loadMcpServers(ctx, { mcpConfigJson: config })).loadedServerNames;
      return { ping, updateEnvironmentVariables, loadServers };
    },

    createExecClient(transport): BoxRemoteExecClient {
      if (typeof transport !== "object" || transport === null) {
        throw new TypeError("box transport must be an object");
      }
      const target = nativeTargets.get(transport);
      if (target === undefined) throw new TypeError("box transport was not created by this production adapter");
      return createSlateBoxRemoteExecClient(createSlateBoxExecClient(target, fetcher));
    },
    ...accessorPolicies,
  };
}

const productionBoxGeneratedPackageBindings: ProductionBoxGeneratedPackageBindings<
  Transport,
  PingRequest,
  UpdateEnvironmentVariablesRequest,
  LoadMcpServersRequest
> = {
  createConnectTransport: createConnectTransport as unknown as BoxTransportFactory<Transport>,
  createContextPropagatingClient: createContextPropagatingClient as unknown as GeneratedContextPropagatingClientFactory<
    Transport,
    PingRequest,
    UpdateEnvironmentVariablesRequest,
    LoadMcpServersRequest
  >,
  controlService: ControlService as unknown as GeneratedServiceDescriptor<"agent.v1.ControlService">,
  execService: ExecService as unknown as GeneratedServiceDescriptor<"agent.v1.ExecService">,
  PingRequest,
  UpdateEnvironmentVariablesRequest,
  LoadMcpServersRequest
};

export const productionBoxGeneratedPorts = createProductionBoxGeneratedPorts(
  productionBoxGeneratedPackageBindings
);
