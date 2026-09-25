/**
 * The operations behind a background shell: starting one, and writing to a shell that is already running.
 *
 * A background shell outlives the turn that started it, so it needs two operations rather than one: starting it, and later writing to it — the second of which exists because a shell's input arrives from a different turn than the command did. Both travel over the same channel as any other operation, which is what lets a session on one machine drive a shell on another.
 */

import { SimpleControlledExecHandler } from "./controlled-exec.ts";
import { ExecutorResource, type Executor, type RemoteExecManager } from "./executor-resources.ts";
import { createResource, type ControlledExecManager } from "./resource-provider.ts";
import { createClientDeserializer, createClientSerializer, createServerDeserializer, createServerSerializer } from "./exec-serialization.ts";
import type { BackgroundShellSpawnArgs, BackgroundShellSpawnResult, WriteShellStdinArgs, WriteShellStdinResult } from "../proto/generated/agent/v1/background_shell_exec_pb.ts";

export const backgroundShellExecutorResource = createResource<Executor<BackgroundShellSpawnArgs, BackgroundShellSpawnResult>, RemoteExecManager, ControlledExecManager>(
  (execManager) => new ExecutorResource(execManager, createServerSerializer("backgroundShellSpawnArgs"), createClientDeserializer("backgroundShellSpawnResult")),
  (implementation, controlledExecManager) => controlledExecManager.register(new SimpleControlledExecHandler(implementation, createServerDeserializer("backgroundShellSpawnArgs"), createClientSerializer("backgroundShellSpawnResult"))),
);
export const writeBackgroundShellInputExecutorResource = createResource<Executor<WriteShellStdinArgs, WriteShellStdinResult>, RemoteExecManager, ControlledExecManager>(
  (execManager) => new ExecutorResource(execManager, createServerSerializer("writeShellStdinArgs"), createClientDeserializer("writeShellStdinResult")),
  (implementation, controlledExecManager) => controlledExecManager.register(new SimpleControlledExecHandler(implementation, createServerDeserializer("writeShellStdinArgs"), createClientSerializer("writeShellStdinResult"))),
);
