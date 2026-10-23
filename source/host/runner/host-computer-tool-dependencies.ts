/**
 * What the computer tool needs from the host.
 *
 * The box's desktop, its monitor, its approvals and the shell behind them are gathered here, so the tool asks for one
 * dependency object rather than reaching into the host for each piece. Three projections come out of this module:
 * the computer-use executor, the shell executor that carries the host's approval and audit rules, and the browser
 * driver's identity and shell bridge.
 */
import {
  ComputerUseAction,
  ComputerUseArgs,
  Coordinate,
  ClickAction,
  CursorPositionAction,
  DragAction,
  KeyAction,
  MouseButton,
  MouseDownAction,
  MouseMoveAction,
  MouseUpAction,
  ScrollAction,
  ScrollDirection,
  ScreenshotAction,
  TypeAction,
  WaitAction,
  type ComputerUseResult as GeneratedComputerUseResult,
} from "../../packages/proto/generated/agent/v1/computer_use_tool_pb.ts";
import { computerUseExecutorResource } from "../../packages/agent-exec/computer-use.ts";
import { shellExecutorResource } from "../../packages/agent-exec/shell.ts";
import type { Executor, ExecutorOptions } from "../../packages/agent-exec/executor-resources.ts";
import type { Context } from "../../packages/context/context.ts";
import { buildHostShellArgs, type HostShellArgsInput } from "../boxes/box-shell-command.ts";
import type { ShellArgs, ShellResult } from "../../packages/proto/generated/agent/v1/shell_exec_pb.ts";
import type {
  ComputerProtocolAction,
  ComputerToolDependencies,
  ComputerUseResult,
  ReportedComputerAction,
} from "./tools/slate-computer-tool.ts";
import type { BrowserDriverDependencies } from "./tools/slate-browser-tools.ts";
import type { SlateBrowserAutoReviewOptions } from "./slate-browser-auto-review.ts";
import type { SlateComputerAutoReviewOptions } from "./slate-computer-auto-review.ts";

/** What the host hands the computer tool: the resource accessor and the optional hooks around it. */
export type HostComputerToolProjectionInput<Context = unknown> = {
  readonly resourceAccessor: { get(resource: unknown): unknown };
  readonly persistImage?: (
    bytes: Uint8Array,
    mimeType: string,
  ) => Promise<{ readonly fileUrl: string } | undefined>;
  readonly isUnicodeTypingEnabled?: () => boolean;
  readonly onComputerAction?: (action: ReportedComputerAction) => void;
  readonly autoReview?: SlateComputerAutoReviewOptions;
};

/** What the host hands its shell projection: the resource accessor plus the two safety callbacks. */
export type HostShellExecutorProjectionInput = {
  readonly resourceAccessor: { get(resource: unknown): unknown };
  readonly assertNoPendingApproval: () => void;
  readonly auditShellCommand: (command: string) => void;
};

/** The shell the browser driver executes through. */
export interface HostShellExecutor {
  execute(
    context: unknown,
    toolArgs: HostShellArgsInput,
    options?: ExecutorOptions,
  ): Promise<ShellResult>;
}

/** The box a browser driver drives: its readiness, its window per agent, and its file transfers. */
export type HostBrowserBoxOwner<Context = unknown> = {
  ensureReady(context: Context, agentId: string): Promise<unknown>;
  getAgentWindowIndex(agentId: string): number | undefined;
  uploadFile(context: Context, agentId: string, path: string, bytes: Uint8Array): Promise<void>;
  downloadFile(context: Context, agentId: string, path: string): Promise<Uint8Array>;
};

/** What the host hands the browser driver: its box, its identities and the shell it runs commands through. */
export type HostBrowserDriverProjectionInput<Context = unknown> = {
  readonly resourceAccessor: { get(resource: unknown): unknown };
  readonly box: HostBrowserBoxOwner<Context>;
  readonly getBoxId: () => string;
  readonly getDefaultViewId: () => string;
  readonly executeShell: HostShellExecutor;
  readonly getPersistImage?: BrowserDriverDependencies<Context>["getPersistImage"];
  readonly autoReview?: SlateBrowserAutoReviewOptions;
};

/** One action's payload read as a record, or the refusal for something that is not one. */
type ActionPayload = Readonly<Record<string, unknown>>;

function payloadRecord(payload: unknown, wireCase: string): ActionPayload {
  if (typeof payload !== "object" || payload == null || Array.isArray(payload)) {
    throw new TypeError(`computer action ${wireCase} has no value`);
  }
  return payload as ActionPayload;
}

function finiteField(payload: unknown, field: string): number {
  if (typeof payload !== "number" || !Number.isFinite(payload)) {
    throw new TypeError(`computer action field ${field} is not numeric`);
  }
  return payload;
}

function stringField(payload: unknown, field: string): string {
  if (typeof payload !== "string") {
    throw new TypeError(`computer action field ${field} is not textual`);
  }
  return payload;
}

/** A coordinate when the payload names one, and nothing when it does not. */
function coordinateFrom(payload: unknown): Coordinate | undefined {
  if (payload == null) return undefined;
  const record = payloadRecord(payload, "coordinate");
  return new Coordinate({
    x: finiteField(record.x, "coordinate.x"),
    y: finiteField(record.y, "coordinate.y"),
  });
}

/** A mouse button name as the generated enum, or the refusal for a name it does not know. */
function buttonFromName(payload: unknown): MouseButton {
  if (typeof payload !== "string") {
    throw new TypeError("computer action button is not textual");
  }
  const buttons: Readonly<Record<string, MouseButton>> = {
    LEFT: MouseButton.LEFT,
    RIGHT: MouseButton.RIGHT,
    MIDDLE: MouseButton.MIDDLE,
    BACK: MouseButton.BACK,
    FORWARD: MouseButton.FORWARD,
  };
  const result = buttons[payload];
  if (result === undefined) throw new TypeError(`unknown computer action button: ${payload}`);
  return result;
}

/** A scroll direction name as the generated enum, or the refusal for a name it does not know. */
function directionFromName(payload: unknown): ScrollDirection {
  if (typeof payload !== "string") {
    throw new TypeError("computer action direction is not textual");
  }
  const directions: Readonly<Record<string, ScrollDirection>> = {
    UP: ScrollDirection.UP,
    DOWN: ScrollDirection.DOWN,
    LEFT: ScrollDirection.LEFT,
    RIGHT: ScrollDirection.RIGHT,
  };
  const result = directions[payload];
  if (result === undefined) throw new TypeError(`unknown computer action direction: ${payload}`);
  return result;
}

/** The modifier keys a click, a drag or a scroll was given, when the payload carries them. */
function carriedModifiers(payload: ActionPayload): { modifierKeys?: string } {
  return payload.modifierKeys == null ? {} : { modifierKeys: stringField(payload.modifierKeys, "modifierKeys") };
}

/** One builder per action case: what the payload is read as before the generated action is created. */
type ActionBuilder = (payload: ActionPayload) => ComputerUseAction;

/** The builders for every action the protocol can name, in the case spellings the wire uses. */
const ACTION_READERS: ReadonlyMap<string, ActionBuilder> = new Map<string, ActionBuilder>([
  ["mouseMove", payload => {
    const coordinate = coordinateFrom(payload.coordinate);
    return new ComputerUseAction({
      action: {
        case: "mouseMove",
        value: new MouseMoveAction({
          ...(coordinate === undefined ? {} : { coordinate }),
        }),
      },
    });
  }],
  ["click", payload => {
    const coordinate = coordinateFrom(payload.coordinate);
    return new ComputerUseAction({
      action: {
        case: "click",
        value: new ClickAction({
          ...(coordinate === undefined ? {} : { coordinate }),
          button: buttonFromName(payload.button),
          count: finiteField(payload.count, "count"),
          ...carriedModifiers(payload),
        }),
      },
    });
  }],
  ["mouseDown", payload => new ComputerUseAction({ action: { case: "mouseDown", value: new MouseDownAction({ button: buttonFromName(payload.button) }) } })],
  ["mouseUp", payload => new ComputerUseAction({ action: { case: "mouseUp", value: new MouseUpAction({ button: buttonFromName(payload.button) }) } })],
  ["drag", payload => {
    if (!Array.isArray(payload.path)) throw new TypeError("computer action drag path is not an array");
    const path = payload.path.map(point => {
      const coordinate = coordinateFrom(point);
      if (coordinate === undefined) throw new TypeError("computer action drag path contains no coordinate");
      return coordinate;
    });
    return new ComputerUseAction({
      action: {
        case: "drag",
        value: new DragAction({
          path,
          button: buttonFromName(payload.button),
          ...carriedModifiers(payload),
        }),
      },
    });
  }],
  ["scroll", payload => {
    const coordinate = coordinateFrom(payload.coordinate);
    return new ComputerUseAction({
      action: {
        case: "scroll",
        value: new ScrollAction({
          ...(coordinate === undefined ? {} : { coordinate }),
          direction: directionFromName(payload.direction),
          amount: finiteField(payload.amount, "amount"),
          ...carriedModifiers(payload),
        }),
      },
    });
  }],
  ["type", payload => new ComputerUseAction({ action: { case: "type", value: new TypeAction({ text: stringField(payload.text, "text") }) } })],
  ["key", payload => new ComputerUseAction({
    action: {
      case: "key",
      value: new KeyAction({
        key: stringField(payload.key, "key"),
        ...(payload.holdDurationMs == null ? {} : { holdDurationMs: finiteField(payload.holdDurationMs, "holdDurationMs") }),
      }),
    },
  })],
  ["wait", payload => new ComputerUseAction({ action: { case: "wait", value: new WaitAction({ durationMs: finiteField(payload.durationMs, "durationMs") }) } })],
  ["screenshot", () => new ComputerUseAction({ action: { case: "screenshot", value: new ScreenshotAction({}) } })],
  ["cursorPosition", () => new ComputerUseAction({ action: { case: "cursorPosition", value: new CursorPositionAction({}) } })],
]);

/** One protocol action as the generated computer-use action, refusing what it cannot read. */
function toGeneratedAction(action: ComputerProtocolAction): ComputerUseAction {
  const wireCase = action.action.case;
  if (wireCase === undefined) throw new TypeError("computer action has no case");
  const payload = payloadRecord(action.action.value, wireCase);
  const build = ACTION_READERS.get(wireCase);
  if (build === undefined) throw new TypeError(`unsupported computer action: ${wireCase}`);
  return build(payload);
}

export function toGeneratedComputerUseArgs(toolArgs: {
  readonly toolCallId: string;
  readonly actions: readonly ComputerProtocolAction[];
  readonly bindUnmappedCharacters?: boolean;
  readonly description?: string;
}): ComputerUseArgs {
  return new ComputerUseArgs({
    toolCallId: toolArgs.toolCallId,
    actions: toolArgs.actions.map(toGeneratedAction),
    ...(toolArgs.bindUnmappedCharacters === undefined ? {} : { bindUnmappedCharacters: toolArgs.bindUnmappedCharacters }),
    ...(toolArgs.description === undefined ? {} : { description: toolArgs.description }),
  });
}

/** A successful generated result read as the host's success shape. */
function readGeneratedSuccess(payload: { readonly screenshot?: string | undefined; readonly cursorPosition?: { readonly x: number; readonly y: number } | undefined }): ComputerUseResult {
  return {
    result: {
      case: "success",
      value: {
        ...(payload.screenshot === undefined ? {} : { screenshot: payload.screenshot }),
        ...(payload.cursorPosition === undefined ? {} : { cursorPosition: { x: payload.cursorPosition.x, y: payload.cursorPosition.y } }),
      },
    },
  };
}

/** A generated result read as the host's shape: its success or error, or an empty result it did not name. */
function readGeneratedResult(result: GeneratedComputerUseResult): ComputerUseResult {
  if (result.result.case === "success") return readGeneratedSuccess(result.result.value);
  if (result.result.case === "error") return { result: { case: "error", value: { error: result.result.value.error } } };
  return { result: { case: "" } };
}

/** The computer-use executor a turn's resource accessor carries. */
function carriedComputerUseExecutor(resourceAccessor: { get(resource: unknown): unknown }): Executor<ComputerUseArgs, GeneratedComputerUseResult> {
  return resourceAccessor.get(computerUseExecutorResource) as Executor<ComputerUseArgs, GeneratedComputerUseResult>;
}

/** Run one computer-use request through the turn's executor, reading the generated result back into the host's shape. */
async function runComputerUse(
  executor: Executor<ComputerUseArgs, GeneratedComputerUseResult>,
  context: unknown,
  toolArgs: Parameters<ComputerToolDependencies["execute"]>[1],
): Promise<ComputerUseResult> {
  return readGeneratedResult(await executor.execute(context as never, toGeneratedComputerUseArgs(toolArgs)));
}

/** The computer tool's dependencies, projected from the turn's executor and the caller's hooks. */
export function createHostComputerToolDependencies<Context = unknown>(
  hostInput: HostComputerToolProjectionInput<Context>,
): ComputerToolDependencies<Context> {
  const executor = carriedComputerUseExecutor(hostInput.resourceAccessor);
  return {
    resourceAccessor: hostInput.resourceAccessor,
    async execute(context, toolArgs) {
      return runComputerUse(executor, context, toolArgs);
    },
    getPersistImage: () => hostInput.persistImage,
    ...(hostInput.isUnicodeTypingEnabled === undefined ? {} : { isUnicodeTypingEnabled: hostInput.isUnicodeTypingEnabled }),
    ...(hostInput.onComputerAction === undefined ? {} : { onComputerAction: hostInput.onComputerAction }),
    ...(hostInput.autoReview === undefined ? {} : { autoReview: hostInput.autoReview }),
  };
}

/** The shell executor a turn's resource accessor carries. */
function carriedShellExecutor(resourceAccessor: { get(resource: unknown): unknown }): Executor<ShellArgs, ShellResult> {
  return resourceAccessor.get(shellExecutorResource) as Executor<ShellArgs, ShellResult>;
}

/** Run one shell request after the host's approval and audit rules have seen it. */
async function shellThrough(
  executor: Executor<ShellArgs, ShellResult>,
  guards: HostShellExecutorProjectionInput,
  context: unknown,
  toolArgs: HostShellArgsInput,
  options?: ExecutorOptions,
): Promise<ShellResult> {
  guards.assertNoPendingApproval();
  guards.auditShellCommand(toolArgs.command);
  return await executor.execute(context as Context, buildHostShellArgs(toolArgs), options);
}

/**
 * Projects the real box shell resource without inventing approval or audit behavior. Both safety callbacks are
 * mandatory and run before the generated executor receives the caller's context and abort-bearing options.
 */
export function createHostShellExecutor(hostInput: HostShellExecutorProjectionInput): HostShellExecutor {
  const executor = carriedShellExecutor(hostInput.resourceAccessor);
  return {
    async execute(context, toolArgs, options?: ExecutorOptions) {
      return await shellThrough(executor, hostInput, context, toolArgs, options);
    },
  };
}

/** The browser driver's window index for a conversation: the box must be ready before its window is looked up. */
async function windowIndexOf<Context>(hostInput: HostBrowserDriverProjectionInput<Context>, context: Context): Promise<number | undefined> {
  const boxId = hostInput.getBoxId();
  await hostInput.box.ensureReady(context, boxId);
  return hostInput.box.getAgentWindowIndex(boxId);
}

/** A shell result read as the browser driver's outcome: its success fields, or its failure case. */
function shellOutcome(result: ShellResult): { case: "success"; stdout: string; stderr: string; exitCode: number } | { case: string } {
  if (result.result.case === "success") {
    return {
      case: "success",
      stdout: result.result.value.stdout,
      stderr: result.result.value.stderr,
      exitCode: result.result.value.exitCode,
    };
  }
  return { case: result.result.case ?? "" };
}

/** Send one file into the box for a conversation. */
async function uploadIntoBox<Context>(hostInput: HostBrowserDriverProjectionInput<Context>, context: Context, boxId: string, path: string, bytes: Uint8Array): Promise<void> {
  await hostInput.box.uploadFile(context, boxId, path, bytes);
}

/** Take one file out of the box for a conversation. */
async function downloadFromBox<Context>(hostInput: HostBrowserDriverProjectionInput<Context>, context: Context, boxId: string, path: string): Promise<Uint8Array> {
  return await hostInput.box.downloadFile(context, boxId, path);
}

/** Run one shell request through the shell projection the host supplied. */
async function shellViaDriver<Context>(hostInput: HostBrowserDriverProjectionInput<Context>, context: Context, shellInput: HostShellArgsInput): Promise<{ case: "success"; stdout: string; stderr: string; exitCode: number } | { case: string }> {
  return shellOutcome(await hostInput.executeShell.execute(context, shellInput));
}

/**
 * Projects the immutable browser identity contract. Window readiness is checked before lookup; an unassigned window
 * remains undefined so the browser driver retains its shipped missing-view error. The transcript ID is the default
 * view identity, not a synthetic literal.
 */
export function createHostBrowserDriverDependencies<Context = unknown>(
  hostInput: HostBrowserDriverProjectionInput<Context>,
): BrowserDriverDependencies<Context> {
  return {
    resourceAccessor: hostInput.resourceAccessor,
    async getWindowIndex(context) {
      return await windowIndexOf(hostInput, context);
    },
    getBoxId: hostInput.getBoxId,
    getDefaultViewId: hostInput.getDefaultViewId,
    async uploadFile(context, boxId, path, bytes) {
      await uploadIntoBox(hostInput, context, boxId, path, bytes);
    },
    async downloadFile(context, boxId, path) {
      return await downloadFromBox(hostInput, context, boxId, path);
    },
    async executeShell(context, shellInput) {
      return shellViaDriver(hostInput, context, shellInput);
    },
    ...(hostInput.getPersistImage === undefined ? {} : { getPersistImage: hostInput.getPersistImage }),
    ...(hostInput.autoReview === undefined ? {} : { autoReview: hostInput.autoReview }),
  };
}
