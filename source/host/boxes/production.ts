/** The box this build offers, assembled from what the platform has.

 * Which operations exist, where a box keeps its files, how a box is reached over the wire and what the platform can say
 * about it are all decided here, so the rest of the host asks for a box rather than for the parts it is made of. */
import { errorLogTag } from "../../shared/errors/summary.ts";
import { reportHostDiagnostic } from "../host-diagnostics.ts";
import type { HostBoxInner } from "./forever-box/host-box.ts";
import type { BoxEnvironmentControlClient } from "./box-environment-control.ts";
import type { FileTransferAccessor } from "./box-file-transfer.ts";
import { applySharedDesktop, createBox } from "./box-factory.ts";
import type { BoxMcpPort } from "./box-mcp.ts";
import {
  createBoxTransport,
  type BoxPingControlClient,
  type BoxRemoteExecClient,
  type BoxRemoteExecManager,
  type BoxTransportFactory
} from "./box-remote-accessor.ts";
import type {
  BoxEndpoint,
  LoopbackTelemetry,
} from "./loopback-slate-box.ts";
import type { ShellAccessor } from "./box-windows.ts";
import { createProductionBoxOperations } from "./production-box-operations.ts";
import { decodeBoxEnvironmentUpdate } from "./production-box-environment.ts";
import { createSingleWindowBoxInner } from "./production-box-standalone.ts";

export type ProductionBoxControlClient = BoxPingControlClient &
  BoxEnvironmentControlClient &
  BoxMcpPort;

/**
 * The generated pieces this build hangs a box on: how a box is reached, what it is asked, and what may be done
 * with what it answers. Nothing here owns the box's lifecycle, so the box keeps that to itself.
 */
export interface ProductionBoxGeneratedPorts<
  Transport,
  Accessor extends ShellAccessor & FileTransferAccessor
> {
  readonly createTransport: BoxTransportFactory<Transport>;
  createControlClient(transport: Transport): ProductionBoxControlClient;
  createExecClient(transport: Transport): BoxRemoteExecClient;
  createResourceAccessor(manager: BoxRemoteExecManager): Accessor;
  withFileReadGuard(
    accessor: Accessor,
    assertFileReadAllowed: (path: string) => Promise<void>
  ): Accessor;
  withNoMonitorComputerUse(accessor: Accessor): Accessor;
}

export type ErasedProductionBoxGeneratedPorts = ProductionBoxGeneratedPorts<
  unknown,
  ShellAccessor & FileTransferAccessor
>;

export interface ProductionBoxProviderOptions<
  Transport,
  Accessor extends ShellAccessor & FileTransferAccessor
> {
  readonly generated: ProductionBoxGeneratedPorts<Transport, Accessor>;
  readonly telemetry: LoopbackTelemetry;
  readonly protectedBoxPaths: readonly string[];
  readonly host?: string;
  readonly authToken?: string;
  /**
   * Whether the box runs the image that can hand out more than one desktop. A box that cannot does not claim to,
   * so a caller reaches the one accessor it does have instead of asking for a window that would never appear.
   */
  readonly sharedDesktop?: boolean;
}

export type ProductionBoxInner = HostBoxInner & {
  dispose(): Promise<void>;
};

/**
 * What this build's box is made of: the primitives above composed into one box, with the desktop a shared desktop
 * build offers laid over it and the window assignments kept across a restart.
 */
export function createProductionBoxInner<
  Transport,
  Accessor extends ShellAccessor & FileTransferAccessor
>(
  options: ProductionBoxProviderOptions<Transport, Accessor>
): ProductionBoxInner {
  const { generated } = options;
  const transportFor = (endpoint: BoxEndpoint): Transport =>
    createBoxTransport(endpoint, generated.createTransport);

  const loopback = createBox<Accessor>({
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.authToken === undefined ? {} : { authToken: options.authToken }),
    telemetry: options.telemetry,
    protectedBoxPaths: options.protectedBoxPaths,
    operations: createProductionBoxOperations(generated, transportFor),
  });

  if (options.sharedDesktop === false) {
    return createSingleWindowBoxInner(
      loopback,
      accessor => generated.withNoMonitorComputerUse(accessor)
    );
  }

  const composed = applySharedDesktop(loopback, {
    persistAssignments: true,
    gateComputerUse(primary) {
      return {
        ...primary,
        remoteAccessor: generated.withNoMonitorComputerUse(
          primary.remoteAccessor
        )
      };
    },
    reportPersistFailure(error) {
      reportHostDiagnostic({
        kind: "window_assignment_persist_failed",
        errorClass: errorLogTag(error)
      });
    }
  });
  return composed;
}
