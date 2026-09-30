/** The generated pieces a box is built from, bound to this build's own package versions.

 * The service descriptors, the message constructors and the transport the box's calls run over are bound here, and the
 * two overlays a box needs — a read that is checked against what may be read, and computer use the box does not
 * monitor — are built on top of the accessor the box would otherwise have. */
import type { Transport } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { computerUseExecutorResource } from "../../packages/agent-exec/computer-use.ts";
import {
  CombinedResourceAccessor,
  RemoteResourceAccessor,
  resourceEntry,
  type ResourceAccessor
} from "../../packages/agent-exec/resource-provider.ts";
import { readExecutorResource } from "../../packages/agent-exec/read-operation.ts";
import type { RemoteExecManager } from "../../packages/agent-exec/executor-resources.ts";
import type { Context } from "../../packages/context/context.ts";
import { createContextPropagatingClient } from "../../packages/context-rpc/index.ts";
import {
  LoadMcpServersRequest,
  PingRequest,
  UpdateEnvironmentVariablesRequest
} from "../../packages/proto/generated/agent/v1/control_service_pb.ts";
import { ControlService } from "../../packages/proto/generated/agent/v1/control_service_connect.ts";
import { ExecService } from "../../packages/proto/generated/agent/v1/exec_service_connect.ts";
import {
  noMonitorComputerUseExecutor
} from "../ports/box.ts";
import type {
  BoxEnvironmentControlClient
} from "./box-env.ts";
import type { FileTransferAccessor } from "./box-file-transfer.ts";
import type { BoxMcpControlClient } from "./box-mcp.ts";
import type {
  BoxPingControlClient,
  BoxRemoteExecClient,
  BoxRemoteExecManager,
  BoxTransportFactory
} from "./box-remote-accessor.ts";
import type {
  ProductionBoxControlClient,
  ProductionBoxGeneratedPorts
} from "./production.ts";
import type { ShellAccessor } from "./box-windows.ts";

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

export type ProductionGeneratedBoxAccessor =
  & ResourceAccessor<RemoteExecManager>
  & ShellAccessor
  & FileTransferAccessor;

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
  >
): ProductionBoxGeneratedPorts<Transport, ProductionGeneratedBoxAccessor> {
  const createGeneratedControlClient = (transport: Transport) =>
    bindings.createContextPropagatingClient(bindings.controlService, transport);

  return {
    createTransport: bindings.createConnectTransport,

    createControlClient(transport): ProductionBoxControlClient {
      const client = createGeneratedControlClient(transport);
      const ping: BoxPingControlClient["ping"] = async (ctx, _request, options) =>
        await client.ping(ctx, new bindings.PingRequest(), options);
      const updateEnvironmentVariables: BoxEnvironmentControlClient["updateEnvironmentVariables"] =
        async (ctx, request) => await client.updateEnvironmentVariables(
          ctx,
          new bindings.UpdateEnvironmentVariablesRequest({
            env: request.env,
            replace: request.replace
          })
        );
      const loadMcpServers: BoxMcpControlClient["loadMcpServers"] =
        async (ctx, request) => await client.loadMcpServers(
          ctx,
          new bindings.LoadMcpServersRequest({
            mcpConfigJson: request.mcpConfigJson,
            removeMissing: true
          })
        );
      return { ping, updateEnvironmentVariables, loadMcpServers };
    },

    createExecClient(transport): BoxRemoteExecClient {
      return bindings.createContextPropagatingClient(bindings.execService, transport);
    },

    createResourceAccessor(manager): ProductionGeneratedBoxAccessor {
      return new RemoteResourceAccessor(manager);
    },

    withFileReadGuard(accessor, assertFileReadAllowed): ProductionGeneratedBoxAccessor {
      return new CombinedResourceAccessor(accessor, [
        resourceEntry(readExecutorResource, {
          async execute(ctx, args, options) {
            await assertFileReadAllowed(args.path);
            return await accessor.get(readExecutorResource).execute(ctx, args, options);
          }
        })
      ]);
    },

    withNoMonitorComputerUse(accessor): ProductionGeneratedBoxAccessor {
      return new CombinedResourceAccessor(accessor, [
        resourceEntry(computerUseExecutorResource, noMonitorComputerUseExecutor)
      ]);
    }
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
