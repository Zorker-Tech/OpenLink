/**
 * The local-exec daemon's executor, as it is assembled for a real machine.
 *
 * The daemon runs commands, reads and listings on this computer, and every one of them is decided the same way: a
 * shell's working directory is settled against the machine's root, a file larger than the daemon's limit is refused
 * before it is read, and the codec that turns generated classes into the gateway's JSON is the generated one rather
 * than something that merely looks like it. This module is that assembly, so what the daemon runs is decided in one
 * place instead of by whoever happens to call it.
 */
import { DEFAULT_MAX_LOCAL_EXEC_FILE_BYTES, localExecFileTooLargeMessage } from "../shared/local-exec-gateway.ts";
import type { JsonValue } from "@bufbuild/protobuf";
import {
  buildLocalExecManager,
  resolveLocalExecRoot,
  type LocalExecManagerRuntime,
} from "../host/local-exec/local-exec-machine.ts";
import type {
  LocalExecDecodedMessage,
  LocalExecExecutor,
  LocalExecExecutorOutput,
} from "../host/local-exec/local-exec-provider.ts";
import { backgroundShellExecutorResource } from "../packages/agent-exec/background-shell.ts";
import { SimpleControlledExecManager } from "../packages/agent-exec/controlled-exec.ts";
import {
  ExecClientControlMessage,
  ExecClientMessage,
  ExecClientThrow,
  ExecServerMessage,
} from "../packages/proto/generated/agent/v1/exec_pb.ts";
import {
  ExecServerAbort,
  ExecServerControlMessage,
} from "../packages/proto/generated/agent/v1/agent_service_pb.ts";
import { lsExecutorResource } from "../packages/agent-exec/ls.ts";
import { readExecutorResource } from "../packages/agent-exec/read-operation.ts";
import { RegistryResourceAccessor } from "../packages/agent-exec/resource-provider.ts";
import { shellStreamExecutorResource } from "../packages/agent-exec/shell-stream-operation.ts";
import { createContext, type Context } from "../packages/context/context.ts";
import { LocalBackgroundShellExecutor } from "../packages/local-exec/background-shell.ts";
import { LocalLsExecutor } from "../packages/local-exec/ls.ts";
import { LocalReadExecutor } from "../packages/local-exec/read.ts";
import { BaseShellCoreExecutor } from "../packages/local-exec/shell-core.ts";
import { LocalShellStreamExecutor } from "../packages/local-exec/shell-stream.ts";
import { MockIgnoreService, MockPermissionsService } from "../packages/local-exec/tests/common.ts";
import { ReadError, ReadResult } from "../packages/proto/generated/agent/v1/read_exec_pb.ts";
import { ShellStream, ShellStreamStderr } from "../packages/proto/generated/agent/v1/shell_exec_pb.ts";
import type { SandboxPolicy as ProtoSandboxPolicy } from "../packages/proto/generated/agent/v1/sandbox_pb.ts";
import { createDefaultTerminalExecutor } from "../packages/shell-exec/index.ts";

/** Builds the executor the shipped local-exec daemon gives its gateway provider. */
export type ProductionLocalExecExecutorFactory = () => LocalExecExecutor;

/** What one shell operation carries to the executor: the command and where it runs. */
interface ShellResourceArgs {
  command: string;
  workingDirectory?: string;
  toolCallId?: string;
  conversationId?: string;
  requestedSandboxPolicy?: ProtoSandboxPolicy;
  closeStdin?: boolean;
}

/** What one path operation carries: the path, and the read or list options that may come with it. */
interface PathResourceArgs {
  path: string;
  toolCallId?: string;
  offset?: number;
  limit?: number;
  encodingHint?: string;
  ignore?: readonly string[];
  timeoutMs?: number;
  sandboxPolicy?: unknown;
}

/**
 * The bindings a production runtime must supply.
 *
 * The shipped daemon binds the generated ExecServerMessage, ExecClientMessage and ExecClientControlMessage classes at
 * this boundary, so every codec operation is mandatory: a JSON-shaped substitute must not be presented as the
 * production protobuf transport.
 */
export const PRODUCTION_LOCAL_EXEC_RUNTIME_BINDINGS = Object.freeze([
  "managerRuntime.build",
  "codec.decodeServerMessage",
  "codec.toManagerMessage",
  "codec.isClientMessage",
  "codec.clientMessageToJson",
  "codec.controlMessageToJson",
  "codec.createAbortControl",
  "codec.createThrowControl",
  "createContext",
] as const);

/** Raised at construction time when a runtime does not carry every binding production needs. */
export class ProductionLocalExecCompositionError extends Error {
  constructor(readonly missingBindings: readonly string[]) {
    super(`local-exec production runtime is missing mandatory bindings: ${missingBindings.join(", ")}`);
    this.name = "ProductionLocalExecCompositionError";
  }
}

/** The generated classes as the daemon's codec: one decoded form in, one encoded form out. */
export interface ProductionExecCodec<Server, Client, ClientControl, ServerControl> {
  decodeServerMessage(json: JsonValue): LocalExecDecodedMessage;
  toManagerMessage(message: LocalExecDecodedMessage): Server;
  isClientMessage(message: Client | ClientControl): message is Client;
  clientMessageToJson(message: Client): JsonValue;
  controlMessageToJson(message: ClientControl): JsonValue;
  createAbortControl(execId: number): ServerControl;
  createThrowControl(execId: number, error: string): ClientControl;
}

/** The part of the controlled manager the daemon executor drives. */
export interface ProductionControlledExecManager<Ctx, Server, Client, ClientControl, ServerControl> {
  handle(context: Ctx, message: Server): AsyncIterable<Client | ClientControl>;
  handleControlMessage(message: ServerControl): void;
}

/** Everything a production executor needs from its runtime: the manager builder, the codec and the context factory. */
export interface ProductionLocalExecRuntime<
  Ctx,
  Server,
  Client,
  ClientControl,
  ServerControl,
  Managed extends ProductionControlledExecManager<Ctx, Server, Client, ClientControl, ServerControl>,
> {
  /** Builds the controlled manager over the machine's own resources. */
  readonly managerRuntime: LocalExecManagerRuntime<Managed>;
  readonly codec: ProductionExecCodec<Server, Client, ClientControl, ServerControl>;
  /**
   * Supplies the cancellable context the controlled manager runs under.
   *
   * The shipped no-op logger key has no recovered public export; the controlled manager built here owns its own
   * logging, so the context factory is the only context binding production needs.
   */
  readonly createContext: (signal: AbortSignal) => Ctx;
}

/** How the default executor is built: where the machine's root is and how large a file it will read. */
export interface ProductionLocalExecExecutorOptions<
  Ctx,
  Server,
  Client,
  ClientControl,
  ServerControl,
  Managed extends ProductionControlledExecManager<Ctx, Server, Client, ClientControl, ServerControl>,
> {
  readonly runtime: ProductionLocalExecRuntime<Ctx, Server, Client, ClientControl, ServerControl, Managed>;
  readonly root?: string;
  readonly maxFileBytes?: number;
}

/** A JSON object, which is what an operation's arguments have to be. */
function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A shell operation's arguments: the command must be a string, and a working directory must be one when named. */
function assertShellArguments(value: unknown): asserts value is ShellResourceArgs {
  if (!isRecordObject(value) || typeof value.command !== "string") {
    throw new TypeError("local-exec shell resource arguments require a string command");
  }
  const { workingDirectory } = value;
  if (workingDirectory !== undefined && typeof workingDirectory !== "string") {
    throw new TypeError("local-exec shell workingDirectory must be a string");
  }
}

/** A path operation's arguments: it names a path as a string, and nothing else is looked at here. */
function assertPathArguments(value: unknown): asserts value is PathResourceArgs {
  if (!isRecordObject(value) || typeof value.path !== "string") {
    throw new TypeError("local-exec path resource arguments require a string path");
  }
}

const MANAGER_BUILD_BINDING = "managerRuntime.build";
const CONTEXT_BINDING = "createContext";
const CODEC_BINDING_PREFIX = "codec.";

/** The bindings a runtime does not carry, named in the order a missing one is reported. */
function missingRuntimeBindings(runtime: unknown): string[] {
  const value = runtime as {
    managerRuntime?: { build?: unknown };
    codec?: Record<string, unknown>;
    createContext?: unknown;
  } | null;
  const missing: string[] = [];
  if (typeof value?.managerRuntime?.build !== "function") missing.push(MANAGER_BUILD_BINDING);
  for (const binding of PRODUCTION_LOCAL_EXEC_RUNTIME_BINDINGS) {
    if (!binding.startsWith(CODEC_BINDING_PREFIX)) continue;
    const method = binding.slice(CODEC_BINDING_PREFIX.length);
    if (typeof value?.codec?.[method] !== "function") missing.push(binding);
  }
  if (typeof value?.createContext !== "function") missing.push(CONTEXT_BINDING);
  return missing;
}

/** Refuses a runtime that cannot carry production, naming every binding that is missing. */
export function assertProductionLocalExecRuntime(runtime: unknown): void {
  const missing = missingRuntimeBindings(runtime);
  if (missing.length > 0) throw new ProductionLocalExecCompositionError(missing);
}

/**
 * Adapts the generated codec and controlled-manager graph to the gateway provider's executor.
 *
 * There are deliberately no codec or executor fallbacks: production construction is impossible until both mandatory
 * ports are supplied by our own source.
 */
export function createProductionLocalExecExecutor<
  Ctx,
  Server,
  Client,
  ClientControl,
  ServerControl,
  Managed extends ProductionControlledExecManager<Ctx, Server, Client, ClientControl, ServerControl>,
>(options: ProductionLocalExecExecutorOptions<Ctx, Server, Client, ClientControl, ServerControl, Managed>): LocalExecExecutor {
  assertProductionLocalExecRuntime(options.runtime);
  const root = options.root ?? resolveLocalExecRoot();
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_LOCAL_EXEC_FILE_BYTES;
  const controlledManager = buildLocalExecManager(root, maxFileBytes, options.runtime.managerRuntime);
  const { codec } = options.runtime;

  return {
    decodeServerMessage: (json) => codec.decodeServerMessage(json),
    async *execute(message, signal) {
      const context = options.runtime.createContext(signal);
      for await (const output of controlledManager.handle(context, codec.toManagerMessage(message))) {
        yield codec.isClientMessage(output)
          ? { kind: "client", message: codec.clientMessageToJson(output) }
          : { kind: "control", message: codec.controlMessageToJson(output) };
      }
    },
    cancel(execId) {
      controlledManager.handleControlMessage(codec.createAbortControl(execId));
    },
    throwControl(error) {
      return codec.controlMessageToJson(codec.createThrowControl(0, error));
    },
  };
}

/** A package context that is cancelled as soon as the caller's signal is. */
function contextCancelledBy(signal: AbortSignal): Context {
  const [context, cancel] = createContext().withCancel();
  const cancelWithSignalReason = () => cancel(signal.reason);
  if (signal.aborted) cancelWithSignalReason();
  else signal.addEventListener("abort", cancelWithSignalReason, { once: true });
  return context;
}

/**
 * The manager-facing view of one generated server message.
 *
 * The id is assigned by the daemon before the manager sees the message, so this is a live view of the generated class
 * rather than a copy: the message case is reported as the generated class reports it, and the value only when the
 * generated class carries a record for it.
 */
class CodecServerMessage implements LocalExecDecodedMessage {
  constructor(readonly generated: ExecServerMessage) {}

  get id(): number {
    return this.generated.id;
  }
  set id(value: number) {
    this.generated.id = value;
  }

  get message(): { readonly case?: string; readonly value?: Record<string, unknown> } {
    const { case: messageCase, value } = this.generated.message;
    if (messageCase === undefined) return {};
    if (!isRecordObject(value)) return { case: messageCase };
    return { case: messageCase, value };
  }
}

/** The generated codec: the classes the wire itself was generated from, bound to the executor's view. */
function generatedWireCodec(): ProductionExecCodec<ExecServerMessage, ExecClientMessage, ExecClientControlMessage, ExecServerControlMessage> {
  return {
    decodeServerMessage: (json) => new CodecServerMessage(ExecServerMessage.fromJson(json, { ignoreUnknownFields: true })),
    toManagerMessage: (message) => {
      if (!(message instanceof CodecServerMessage)) {
        throw new TypeError("local-exec decoded message did not originate from the generated production codec");
      }
      return message.generated;
    },
    isClientMessage: (message): message is ExecClientMessage => message instanceof ExecClientMessage,
    clientMessageToJson: (message) => message.toJson(),
    controlMessageToJson: (message) => message.toJson(),
    createAbortControl: (execId) => new ExecServerControlMessage({
      message: { case: "abort", value: new ExecServerAbort({ id: execId }) },
    }),
    createThrowControl: (execId, error) => new ExecClientControlMessage({
      message: { case: "throw", value: new ExecClientThrow({ id: execId, error }) },
    }),
  };
}

/** The guards the controlled manager's runtime hands to its builder. */
type LocalExecGuards = Parameters<LocalExecManagerRuntime<unknown>["build"]>[2];

/** Where a shell operation's working directory ended up. */
interface ShellDirectoryResolution {
  readonly workingDirectory: string;
  readonly fellBackToRoot: boolean;
}

/** A shell operation's arguments after its working directory has been settled. */
interface SettledShellOperation {
  readonly args: ShellResourceArgs;
  readonly requestedDirectory: string;
  readonly resolution: ShellDirectoryResolution;
}

/**
 * Validates a shell operation's arguments and settles the directory it runs in.
 *
 * A directory outside the machine's root falls back to the root, and the directory that was asked for is kept so the
 * caller can be told about the fall back.
 */
async function settleShellOperation(guards: LocalExecGuards, root: string, value: unknown): Promise<SettledShellOperation> {
  assertShellArguments(value);
  const requestedDirectory = value.workingDirectory ?? "";
  const resolution = await guards.resolveShellWorkingDirectory({ root, requested: requestedDirectory });
  value.workingDirectory = resolution.workingDirectory;
  return { args: value, requestedDirectory, resolution };
}

/** The refusal a read gets when the file behind the path is larger than the daemon will read. */
function oversizedReadRefusal(path: string, sizeBytes: number | undefined, maxFileBytes: number): ReadResult | undefined {
  if (sizeBytes === undefined || sizeBytes <= maxFileBytes) return undefined;
  return new ReadResult({
    result: {
      case: "error",
      value: new ReadError({ path, error: localExecFileTooLargeMessage(sizeBytes, maxFileBytes) }),
    },
  });
}

/** Every operation the daemon serves, registered against the machine's own executors. */
function localExecResourceRegistry(root: string, maxFileBytes: number, guards: LocalExecGuards): RegistryResourceAccessor {
  const permissionsService = new MockPermissionsService();
  const ignoreService = new MockIgnoreService();
  const terminalExecutor = createDefaultTerminalExecutor({
    env: { CURSOR_AGENT: "1", SLATE_AGENT: "1" },
  }).clone(root);
  const shellCoreExecutor = new BaseShellCoreExecutor(terminalExecutor, root, root);
  const backgroundShellExecutor = new LocalBackgroundShellExecutor(
    permissionsService,
    shellCoreExecutor,
    ignoreService,
    root,
    undefined,
    undefined,
  );
  const shellStreamExecutor = new LocalShellStreamExecutor(
    permissionsService,
    shellCoreExecutor,
    ignoreService,
    backgroundShellExecutor.getManager(),
  );
  const readExecutor = new LocalReadExecutor(permissionsService, root);
  const lsExecutor = new LocalLsExecutor(permissionsService, ignoreService, root);
  const registry = new RegistryResourceAccessor();

  registry.register(shellStreamExecutorResource, {
    execute: (ctx: Context, argsValue: unknown) => (async function* () {
      const operation = await settleShellOperation(guards, root, argsValue);
      if (operation.resolution.fellBackToRoot) {
        yield new ShellStream({
          event: {
            case: "stderr",
            value: new ShellStreamStderr({ data: guards.missingWorkingDirectoryNotice({ requested: operation.requestedDirectory, root }) }),
          },
        });
      }
      yield* shellStreamExecutor.execute(ctx, operation.args);
    })(),
  });
  registry.register(backgroundShellExecutorResource, {
    execute: async (ctx: Context, argsValue: unknown) => {
      const operation = await settleShellOperation(guards, root, argsValue);
      return backgroundShellExecutor.execute(ctx, operation.args);
    },
  });
  registry.register(readExecutorResource, {
    execute: async (ctx: Context, argsValue: unknown) => {
      assertPathArguments(argsValue);
      const resolvedPath = await guards.containPath({ root, path: argsValue.path });
      const refusal = oversizedReadRefusal(resolvedPath, await guards.regularFileSizeBytes(resolvedPath), maxFileBytes);
      return refusal ?? readExecutor.execute(ctx, argsValue);
    },
  });
  registry.register(lsExecutorResource, {
    execute: async (ctx: Context, argsValue: unknown) => {
      assertPathArguments(argsValue);
      await guards.containPath({ root, path: argsValue.path });
      return lsExecutor.execute(ctx, argsValue);
    },
  });
  return registry;
}

/** The runtime the default executor builds its manager from: the machine's own resources. */
function defaultManagerRuntime(): LocalExecManagerRuntime<SimpleControlledExecManager> {
  return {
    build(root, maxFileBytes, guards) {
      return SimpleControlledExecManager.fromResources(localExecResourceRegistry(root, maxFileBytes, guards));
    },
  };
}

/**
 * The executor the shipped daemon builds for this machine.
 *
 * The resources are the first-party ones wired over the machine's own terminal support; stateful terminal creation
 * stays lazy inside createDefaultTerminalExecutor, so building the executor does not pretend that a native shell
 * binding already exists.
 */
export function createDefaultProductionLocalExecExecutor(options: {
  readonly root?: string;
  readonly maxFileBytes?: number;
} = {}): LocalExecExecutor {
  return createProductionLocalExecExecutor({
    runtime: {
      managerRuntime: defaultManagerRuntime(),
      codec: generatedWireCodec(),
      createContext: contextCancelledBy,
    },
    ...(options.root === undefined ? {} : { root: options.root }),
    ...(options.maxFileBytes === undefined ? {} : { maxFileBytes: options.maxFileBytes }),
  });
}
