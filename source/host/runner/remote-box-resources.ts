/**
 * The resources a box offers the runner.
 *
 * A box is asked for what it can do — run a command, read or write a file, drive its desktop — and each of those is
 * handed to the runner as a resource with the deadlines the platform applies.
 */
import {
  backgroundShellExecutorResource,
} from "../../packages/agent-exec/background-shell.ts";
import { computerUseExecutorResource } from "../../adapters/interop/agent/computer-use-executor-adapter.ts";
import { readExecutorResource } from "../../packages/agent-exec/read-operation.ts";
import {
  RegistryResourceAccessor,
  type ResourceAccessor,
} from "../../packages/agent-exec/resource-provider.ts";
import { shellExecutorResource } from "../../packages/agent-exec/shell.ts";
import { shellStreamExecutorResource } from "../../packages/agent-exec/shell-stream-operation.ts";
import { smartModeClassifierExecutorResource } from "../../packages/agent-exec/smart-mode-classifier-operation.ts";
import type { RemoteExecManager } from "../../packages/agent-exec/executor-resources.ts";
import type { Context } from "../../packages/context/context.ts";
import {
  computerUseActionForAudit,
  shellCommandForAudit,
} from "../../adapters/interop/agent/remote-box-resource-adapter.ts";
import {
  boxAgentWindowIndex,
  boxIsPreparing,
  type CapableBox,
} from "../boxes/box-capabilities.ts";
import {
  touchSlateMonitorBusyLease,
  type BoxWindowShellCommandExecutor,
  type ShellAccessor,
} from "../boxes/box-windows.ts";
import {
  boxNotReadyMessageForError,
  isNoMonitorComputerUseExecutor,
  SlateBoxNoMonitorAvailableError,
  SLATE_BOX_NOT_READY_MESSAGE,
} from "../ports/box.ts";
import { requestIdKey } from "../../adapters/interop/chat-inference-proto/client.ts";

export class BoxNotReadyError extends Error {
  override readonly name = "BoxNotReadyError";
}

export interface RemoteConnection {
  readonly terminalsFolder: string;
  readonly remoteAccessor: ResourceAccessor<RemoteExecManager>;
}

interface NavigationProbe {
  captureBaseline(
    context: Context,
    remoteAccessor: ResourceAccessor<RemoteExecManager>,
    windowIndex: number,
  ): Promise<void> | undefined;
}

export interface RemoteBoxResourceHost {
  readonly executeWindowCommand: BoxWindowShellCommandExecutor;
  readonly remoteBox: CapableBox & {
    ensureReady(context: Context, agentId: string): Promise<RemoteConnection>;
  };
  readonly remoteBoxHasDesktop: boolean;
  readonly preparedRemoteBoxConnection?: Promise<RemoteConnection | undefined>;
  resolveBoxId(): string;
  getConversationId(): string;
  setRemoteBoxTerminalsFolder(folder: string): void;
  readonly autoReviewGate: {
    assertNoPendingApproval(): void;
    currentModes(): Readonly<Record<string, string>>;
  };
  auditShellCommand(
    agentId: string,
    kind: "foreground" | "background",
    command: string,
    target: "box",
    attribution: { readonly turnId?: string; readonly boxId?: string },
  ): void;
  readonly computerUse: {
    getOrCreateNavigationProbe(): NavigationProbe | undefined;
    recordAuditIntent(actionCase: string | undefined): void;
  };
  probeNavigationAfterComputerUse(
    context: Context,
    connection: RemoteConnection,
  ): void;
  readonly autoReviewClassifierExecutor?: unknown;
}

interface RemoteExecutorPort {
  execute(context: Context, args: unknown, options?: unknown): unknown;
}

function executorAt(connection: RemoteConnection, resource: unknown): RemoteExecutorPort {
  const accessor = connection.remoteAccessor as unknown as { get(resource: unknown): RemoteExecutorPort };
  return accessor.get(resource);
}

export function createRemoteBoxResourceAccessor(host: RemoteBoxResourceHost) {
  const box = host.remoteBox;
  const boxId = host.resolveBoxId();
  const agentId = host.getConversationId();
  let connectionPromise: Promise<RemoteConnection | undefined> | undefined;
  const preparedConnection = host.preparedRemoteBoxConnection;

  const connect = async (context: Context): Promise<RemoteConnection> => {
    if (boxIsPreparing(box, boxId)) {
      throw new BoxNotReadyError(SLATE_BOX_NOT_READY_MESSAGE);
    }
    try {
      const connection = await (
        connectionPromise ??= (async () =>
          await preparedConnection ?? box.ensureReady(context, boxId))()
      );
      if (connection == null) throw new Error(SLATE_BOX_NOT_READY_MESSAGE);
      host.setRemoteBoxTerminalsFolder(connection.terminalsFolder);
      return connection;
    } catch (error) {
      connectionPromise = undefined;
      throw new BoxNotReadyError(boxNotReadyMessageForError(error), { cause: error });
    }
  };

  const audit = (
    context: Context,
    kind: "foreground" | "background",
    command: string,
  ): void => {
    const turnId = context.get(requestIdKey);
    host.auditShellCommand(agentId, kind, command, "box", {
      ...(turnId === undefined ? {} : { turnId }),
      boxId,
    });
  };
  const guardAutoReviewBarrier = (): void => host.autoReviewGate.assertNoPendingApproval();

  const ownsMonitorForShellNavigationAudit = (connection: RemoteConnection): boolean => {
    if (!host.remoteBoxHasDesktop) return false;
    try {
      return !isNoMonitorComputerUseExecutor(
        connection.remoteAccessor.get(computerUseExecutorResource),
      );
    } catch {
      return false;
    }
  };

  const awaitShellNavigationBaseline = async (
    context: Context,
    connection: RemoteConnection,
  ): Promise<void> => {
    if (!ownsMonitorForShellNavigationAudit(connection)) return;
    await host.computerUse.getOrCreateNavigationProbe()?.captureBaseline(
      context.withDetached(),
      connection.remoteAccessor,
      boxAgentWindowIndex(box, boxId) ?? 1,
    );
  };

  const probeNavigationAfterShell = (
    context: Context,
    connection: RemoteConnection,
  ): void => {
    if (ownsMonitorForShellNavigationAudit(connection)) {
      host.probeNavigationAfterComputerUse(context, connection);
    }
  };

  const accessor = new RegistryResourceAccessor();
  accessor.register(shellStreamExecutorResource, {
    execute: (context: Context, args: unknown, options?: unknown) => (async function* () {
      guardAutoReviewBarrier();
      audit(context, "foreground", shellCommandForAudit(args));
      const connection = await connect(context);
      guardAutoReviewBarrier();
      await awaitShellNavigationBaseline(context, connection);
      guardAutoReviewBarrier();
      try {
        yield* executorAt(connection, shellStreamExecutorResource).execute(
          context,
          args,
          options,
        ) as AsyncIterable<unknown>;
      } finally {
        probeNavigationAfterShell(context, connection);
      }
    })(),
  } as never);
  accessor.register(backgroundShellExecutorResource, {
    execute: async (
      context: Context,
      args: unknown,
      options?: unknown,
    ): Promise<unknown> => {
      guardAutoReviewBarrier();
      audit(context, "background", shellCommandForAudit(args));
      const connection = await connect(context);
      guardAutoReviewBarrier();
      await awaitShellNavigationBaseline(context, connection);
      guardAutoReviewBarrier();
      try {
        return await executorAt(connection, backgroundShellExecutorResource).execute(
          context,
          args,
          options,
        );
      } finally {
        probeNavigationAfterShell(context, connection);
      }
    },
  } as never);
  accessor.register(readExecutorResource, {
    execute: async (
      context: Context,
      args: unknown,
      options?: unknown,
    ): Promise<unknown> => {
      const connection = await connect(context);
      return await executorAt(connection, readExecutorResource).execute(
        context,
        args,
        options,
      );
    },
  } as never);
  accessor.register(shellExecutorResource, {
    execute: async (
      context: Context,
      args: unknown,
      options?: unknown,
    ): Promise<unknown> => {
      guardAutoReviewBarrier();
      const connection = await connect(context);
      guardAutoReviewBarrier();
      return await executorAt(connection, shellExecutorResource).execute(
        context,
        args,
        options,
      );
    },
  } as never);
  accessor.register(computerUseExecutorResource, {
    execute: async (
      context: Context,
      args: unknown,
      options?: unknown,
    ): Promise<unknown> => {
      const connection = await connect(context);
      let ownsMonitorForNavigationAudit = false;
      try {
        const inner = executorAt(connection, computerUseExecutorResource);
        if (isNoMonitorComputerUseExecutor(inner)) {
          throw new SlateBoxNoMonitorAvailableError();
        }
        ownsMonitorForNavigationAudit = true;
        const windowIndex = boxAgentWindowIndex(box, boxId) ?? 1;
        void host.computerUse.getOrCreateNavigationProbe()?.captureBaseline(
          context.withDetached(),
          connection.remoteAccessor,
          windowIndex,
        );
        await touchSlateMonitorBusyLease(
          context,
          connection.remoteAccessor as ShellAccessor,
          host.executeWindowCommand,
          windowIndex,
        );
        guardAutoReviewBarrier();
        const result = await inner.execute(context, args, options);
        host.computerUse.recordAuditIntent(computerUseActionForAudit(args));
        return result;
      } catch (error) {
        if (error instanceof SlateBoxNoMonitorAvailableError) {
          connectionPromise = undefined;
          throw new BoxNotReadyError(boxNotReadyMessageForError(error), { cause: error });
        }
        throw error;
      } finally {
        if (ownsMonitorForNavigationAudit) {
          host.probeNavigationAfterComputerUse(context, connection);
        }
      }
    },
  } as never);

  if (
    host.autoReviewClassifierExecutor !== undefined
    && Object.values(host.autoReviewGate.currentModes()).some(mode => mode !== "off")
  ) {
    accessor.register(smartModeClassifierExecutorResource, host.autoReviewClassifierExecutor as never);
  }
  return accessor;
}
