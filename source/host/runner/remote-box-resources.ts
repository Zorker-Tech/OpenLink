/**
 * The resources a box offers the runner.
 *
 * A box is asked for what it can do — run a command, read or write a file, drive its desktop — and each of those is
 * handed to the runner as a resource with the deadlines the platform applies.
 */
import {
  backgroundShellExecutorResource,
} from "../../packages/agent-exec/background-shell.ts";
import { computerUseExecutorResource } from "../../packages/agent-exec/computer-use.ts";
import { readExecutorResource } from "../../packages/agent-exec/read-operation.ts";
import {
  RegistryResourceAccessor,
  type ResourceAccessor,
} from "../../packages/agent-exec/resource-provider.ts";
import { shellExecutorResource } from "../../packages/agent-exec/shell.ts";
import { shellStreamExecutorResource } from "../../packages/agent-exec/shell-stream-operation.ts";
import { smartModeClassifierExecutorResource } from "../../packages/agent-exec/smart-mode-classifier-operation.ts";
import type {
  Executor,
  RemoteExecManager,
  StreamExecutor,
} from "../../packages/agent-exec/executor-resources.ts";
import type { Context } from "../../packages/context/context.ts";
import type {
  BackgroundShellSpawnArgs,
  BackgroundShellSpawnResult,
} from "../../packages/proto/generated/agent/v1/background_shell_exec_pb.ts";
import type {
  ComputerUseArgs,
  ComputerUseResult,
} from "../../packages/proto/generated/agent/v1/computer_use_tool_pb.ts";
import type { ReadArgs, ReadResult } from "../../packages/proto/generated/agent/v1/read_exec_pb.ts";
import type { ShellArgs, ShellResult, ShellStream } from "../../packages/proto/generated/agent/v1/shell_exec_pb.ts";
import type {
  SmartModeClassifierArgs,
  SmartModeClassifierResult,
} from "../../packages/proto/generated/agent/v1/smart_mode_classifier_exec_pb.ts";
import {
  boxAgentWindowIndex,
  boxIsPreparing,
  type CapableBox,
} from "../boxes/box-capabilities.ts";
import { touchSlateMonitorBusyLease, type ShellAccessor } from "../boxes/box-windows.ts";
import {
  boxNotReadyMessageForError,
  isNoMonitorComputerUseExecutor,
  SlateBoxNoMonitorAvailableError,
  SLATE_BOX_NOT_READY_MESSAGE,
} from "../ports/box.ts";
import { requestIdKey } from "../../packages/chat-inference-proto/client.ts";

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
  readonly autoReviewClassifierExecutor?: Executor<
    SmartModeClassifierArgs,
    SmartModeClassifierResult
  >;
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
    execute: (context: Context, args: ShellArgs, options) => (async function* () {
      guardAutoReviewBarrier();
      audit(context, "foreground", args.command);
      const connection = await connect(context);
      guardAutoReviewBarrier();
      await awaitShellNavigationBaseline(context, connection);
      guardAutoReviewBarrier();
      try {
        yield* connection.remoteAccessor.get(shellStreamExecutorResource).execute(
          context,
          args,
          options,
        );
      } finally {
        probeNavigationAfterShell(context, connection);
      }
    })(),
  } satisfies StreamExecutor<ShellArgs, ShellStream>);
  accessor.register(backgroundShellExecutorResource, {
    execute: async (
      context: Context,
      args: BackgroundShellSpawnArgs,
      options,
    ): Promise<BackgroundShellSpawnResult> => {
      guardAutoReviewBarrier();
      audit(context, "background", args.command);
      const connection = await connect(context);
      guardAutoReviewBarrier();
      await awaitShellNavigationBaseline(context, connection);
      guardAutoReviewBarrier();
      try {
        return await connection.remoteAccessor.get(backgroundShellExecutorResource).execute(
          context,
          args,
          options,
        );
      } finally {
        probeNavigationAfterShell(context, connection);
      }
    },
  } satisfies Executor<BackgroundShellSpawnArgs, BackgroundShellSpawnResult>);
  accessor.register(readExecutorResource, {
    execute: async (
      context: Context,
      args: ReadArgs,
      options,
    ): Promise<ReadResult> => {
      const connection = await connect(context);
      return await connection.remoteAccessor.get(readExecutorResource).execute(
        context,
        args,
        options,
      );
    },
  } satisfies Executor<ReadArgs, ReadResult>);
  accessor.register(shellExecutorResource, {
    execute: async (
      context: Context,
      args: ShellArgs,
      options,
    ): Promise<ShellResult> => {
      guardAutoReviewBarrier();
      const connection = await connect(context);
      guardAutoReviewBarrier();
      return await connection.remoteAccessor.get(shellExecutorResource).execute(
        context,
        args,
        options,
      );
    },
  } satisfies Executor<ShellArgs, ShellResult>);
  accessor.register(computerUseExecutorResource, {
    execute: async (
      context: Context,
      args: ComputerUseArgs,
      options,
    ): Promise<ComputerUseResult> => {
      const connection = await connect(context);
      let ownsMonitorForNavigationAudit = false;
      try {
        const inner = connection.remoteAccessor.get(computerUseExecutorResource);
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
          windowIndex,
        );
        guardAutoReviewBarrier();
        const result = await inner.execute(context, args, options);
        host.computerUse.recordAuditIntent(args.actions[0]?.action.case);
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
  } satisfies Executor<ComputerUseArgs, ComputerUseResult>);

  if (
    host.autoReviewClassifierExecutor !== undefined
    && Object.values(host.autoReviewGate.currentModes()).some(mode => mode !== "off")
  ) {
    accessor.register(
      smartModeClassifierExecutorResource,
      host.autoReviewClassifierExecutor,
    );
  }
  return accessor;
}
