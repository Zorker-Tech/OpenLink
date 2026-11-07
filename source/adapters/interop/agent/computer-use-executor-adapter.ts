import { SimpleControlledExecHandler } from "./controlled-exec-manager-adapter.ts"
import { ExecutorResource, type Executor, type RemoteExecManager } from "../../../packages/agent-exec/executor-resources.ts"
import { createResource, type ControlledExecManager } from "../../../packages/agent-exec/resource-provider.ts"
import type { Context } from "../../../packages/context/context.ts"
import type { ResourceAccessor } from "../../../packages/agent-exec/resource-provider.ts"
import {
  createClientDeserializer,
  createClientSerializer,
  createServerDeserializer,
  createServerSerializer,
} from "./exec-message-adapter.ts"
import {
  ClickAction,
  Coordinate,
  CursorPositionAction,
  ComputerUseAction,
  ComputerUseArgs,
  ComputerUseError,
  ComputerUseResult as GeneratedComputerUseResultClass,
  type ComputerUseResult as GeneratedComputerUseResult,
  ComputerUseSuccess,
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
} from "../../interop/proto/generated/agent/v1/computer_use_tool_pb.ts"
import type { SlateComputerUseResult } from "../../../host/runner/tools/slate-computer-tool.ts"
import type {
  SlateComputerMouseButton,
  SlateComputerScrollDirection,
  SlateComputerCoordinate,
  SlateComputerUseAction,
  SlateComputerUseExecutorRequest,
} from "../../../packages/agent/conversation-step-state.ts"

/** Keeps the executor registry's public surface in Slate types and owns generated conversion locally. */
export const computerUseExecutorResource = createResource<
  Executor<SlateComputerUseExecutorRequest, SlateComputerUseResult>,
  RemoteExecManager,
  ControlledExecManager
>(
  (execManager) => {
    const generatedExecutor = new ExecutorResource(
      execManager,
      createServerSerializer("computerUseArgs"),
      createClientDeserializer("computerUseResult"),
    );
    return {
      async execute(context, args, options) {
        return readGeneratedResult(await generatedExecutor.execute(context, toGeneratedComputerUseArgs(args), options));
      },
    };
  },
  (implementation, controlledExecManager) => controlledExecManager.register(
    new SimpleControlledExecHandler<ComputerUseArgs, GeneratedComputerUseResult>(
      {
        async execute(context, args, options) {
          const slateRequest = slateComputerUseRequestFromGenerated(args);
          const slateResult = await implementation.execute(context, slateRequest, options);
          return generatedComputerUseResultFromSlate(slateResult);
        },
      },
      createServerDeserializer("computerUseArgs"),
      createClientSerializer("computerUseResult"),
    ),
  ),
)

function coordinateToGenerated(value: { readonly x: number; readonly y: number }): Coordinate {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("computer action coordinate has no value");
  }
  return new Coordinate({
    x: int32Number(value.x, "coordinate.x"),
    y: int32Number(value.y, "coordinate.y"),
  });
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`computer action field ${field} is not numeric`);
  }
  return value;
}

function int32Number(value: unknown, field: string): number {
  const number = finiteNumber(value, field);
  if (!Number.isInteger(number) || number < -2_147_483_648 || number > 2_147_483_647) {
    throw new TypeError(`computer action field ${field} is not a 32-bit integer`);
  }
  return number;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string") throw new TypeError(`computer action field ${field} is not textual`);
  return value;
}

function optionalModifiers(value: unknown): { modifierKeys?: string } {
  return value === undefined ? {} : { modifierKeys: stringValue(value, "modifierKeys") };
}

function mouseButtonToGenerated(value: SlateComputerMouseButton): MouseButton {
  if (typeof value !== "string") {
    if (value?.kind === "unknown" && Number.isInteger(value.code) &&
        value.code >= -2_147_483_648 && value.code <= 2_147_483_647) return value.code as MouseButton;
    throw new TypeError("computer action button is not textual");
  }
  switch (value) {
    case "unspecified": return MouseButton.UNSPECIFIED;
    case "left": return MouseButton.LEFT;
    case "right": return MouseButton.RIGHT;
    case "middle": return MouseButton.MIDDLE;
    case "back": return MouseButton.BACK;
    case "forward": return MouseButton.FORWARD;
    default: throw new TypeError(`unknown computer action button: ${value}`);
  }
}

function scrollDirectionToGenerated(value: SlateComputerScrollDirection): ScrollDirection {
  if (typeof value !== "string") {
    if (value?.kind === "unknown" && Number.isInteger(value.code) &&
        value.code >= -2_147_483_648 && value.code <= 2_147_483_647) return value.code as ScrollDirection;
    throw new TypeError("computer action direction is not textual");
  }
  switch (value) {
    case "unspecified": return ScrollDirection.UNSPECIFIED;
    case "up": return ScrollDirection.UP;
    case "down": return ScrollDirection.DOWN;
    case "left": return ScrollDirection.LEFT;
    case "right": return ScrollDirection.RIGHT;
    default: throw new TypeError(`unknown computer action direction: ${value}`);
  }
}

/** Encodes a Slate action only where the installed executor still requires its generated request. */
function generatedActionFromSlate(action: SlateComputerUseAction<string>): ComputerUseAction {
  if (action === null || typeof action !== "object" || Array.isArray(action)) {
    throw new TypeError("computer action must be an object");
  }
  switch (action.kind) {
    case "mouse-move":
      return new ComputerUseAction({ action: {
        case: "mouseMove",
        value: new MouseMoveAction({ ...(action.coordinate === undefined ? {} : { coordinate: coordinateToGenerated(action.coordinate) }) }),
      } });
    case "click":
      return new ComputerUseAction({ action: {
        case: "click",
        value: new ClickAction({
          ...(action.coordinate === undefined ? {} : { coordinate: coordinateToGenerated(action.coordinate) }),
          button: mouseButtonToGenerated(action.button),
          count: int32Number(action.count, "count"),
          ...optionalModifiers(action.modifierKeys),
        }),
      } });
    case "mouse-down":
      return new ComputerUseAction({ action: { case: "mouseDown", value: new MouseDownAction({ button: mouseButtonToGenerated(action.button) }) } });
    case "mouse-up":
      return new ComputerUseAction({ action: { case: "mouseUp", value: new MouseUpAction({ button: mouseButtonToGenerated(action.button) }) } });
    case "drag":
      if (!Array.isArray(action.path)) throw new TypeError("computer action drag path is not an array");
      return new ComputerUseAction({ action: {
        case: "drag",
        value: new DragAction({
          path: action.path.map(coordinateToGenerated),
          button: mouseButtonToGenerated(action.button),
          ...optionalModifiers(action.modifierKeys),
        }),
      } });
    case "scroll":
      return new ComputerUseAction({ action: {
        case: "scroll",
        value: new ScrollAction({
          ...(action.coordinate === undefined ? {} : { coordinate: coordinateToGenerated(action.coordinate) }),
          direction: scrollDirectionToGenerated(action.direction),
          amount: int32Number(action.amount, "amount"),
          ...optionalModifiers(action.modifierKeys),
        }),
      } });
    case "type":
      return new ComputerUseAction({ action: { case: "type", value: new TypeAction({ text: stringValue(action.text, "text") }) } });
    case "key":
      return new ComputerUseAction({ action: {
        case: "key",
        value: new KeyAction({
          key: stringValue(action.key, "key"),
          ...(action.holdDurationMs === undefined ? {} : { holdDurationMs: int32Number(action.holdDurationMs, "holdDurationMs") }),
        }),
      } });
    case "wait":
      return new ComputerUseAction({ action: { case: "wait", value: new WaitAction({ durationMs: int32Number(action.durationMs, "durationMs") }) } });
    case "screenshot":
      return new ComputerUseAction({ action: { case: "screenshot", value: new ScreenshotAction({}) } });
    case "cursor-position":
      return new ComputerUseAction({ action: { case: "cursorPosition", value: new CursorPositionAction({}) } });
    case "missing":
      return new ComputerUseAction();
    case "unsupported":
      throw new TypeError(`unsupported Slate computer action: ${action.sourceCase}`);
    default: {
      const unsupportedKind = (action as { readonly kind?: unknown })?.kind;
      throw new TypeError(`unsupported Slate computer action: ${String(unsupportedKind)}`);
    }
  }
}

export function toGeneratedComputerUseArgs(toolArgs: SlateComputerUseExecutorRequest): ComputerUseArgs {
  if (toolArgs === null || typeof toolArgs !== "object" || Array.isArray(toolArgs)) {
    throw new TypeError("Slate computer-use request must be an object");
  }
  if (typeof toolArgs.toolCallId !== "string") throw new TypeError("Slate computer-use toolCallId must be text");
  if (!Array.isArray(toolArgs.actions)) throw new TypeError("Slate computer-use actions must be an array");
  if (toolArgs.bindUnmappedCharacters !== undefined && typeof toolArgs.bindUnmappedCharacters !== "boolean") {
    throw new TypeError("Slate computer-use bindUnmappedCharacters must be boolean");
  }
  if (toolArgs.description !== undefined && typeof toolArgs.description !== "string") {
    throw new TypeError("Slate computer-use description must be text");
  }
  return new ComputerUseArgs({
    toolCallId: toolArgs.toolCallId,
    actions: toolArgs.actions.map(generatedActionFromSlate),
    ...(toolArgs.bindUnmappedCharacters === undefined ? {} : { bindUnmappedCharacters: toolArgs.bindUnmappedCharacters }),
    ...(toolArgs.description === undefined ? {} : { description: toolArgs.description }),
  });
}

function slateMouseButtonFromGenerated(value: MouseButton): SlateComputerMouseButton {
  switch (value) {
    case MouseButton.UNSPECIFIED: return "unspecified";
    case MouseButton.LEFT: return "left";
    case MouseButton.RIGHT: return "right";
    case MouseButton.MIDDLE: return "middle";
    case MouseButton.BACK: return "back";
    case MouseButton.FORWARD: return "forward";
    default: return { kind: "unknown", code: value };
  }
}

function slateScrollDirectionFromGenerated(value: ScrollDirection): SlateComputerScrollDirection {
  switch (value) {
    case ScrollDirection.UNSPECIFIED: return "unspecified";
    case ScrollDirection.UP: return "up";
    case ScrollDirection.DOWN: return "down";
    case ScrollDirection.LEFT: return "left";
    case ScrollDirection.RIGHT: return "right";
    default: return { kind: "unknown", code: value };
  }
}

function coordinateFromGenerated(value: Coordinate): SlateComputerCoordinate {
  return { x: value.x, y: value.y };
}

function slateActionFromGenerated(action: ComputerUseAction): SlateComputerUseAction<string> {
  switch (action.action.case) {
    case "mouseMove":
      return {
        kind: "mouse-move",
        ...(action.action.value.coordinate === undefined ? {} : { coordinate: coordinateFromGenerated(action.action.value.coordinate) }),
      };
    case "click":
      return {
        kind: "click",
        ...(action.action.value.coordinate === undefined ? {} : { coordinate: coordinateFromGenerated(action.action.value.coordinate) }),
        button: slateMouseButtonFromGenerated(action.action.value.button),
        count: action.action.value.count,
        ...(action.action.value.modifierKeys === undefined ? {} : { modifierKeys: action.action.value.modifierKeys }),
      };
    case "mouseDown":
      return { kind: "mouse-down", button: slateMouseButtonFromGenerated(action.action.value.button) };
    case "mouseUp":
      return { kind: "mouse-up", button: slateMouseButtonFromGenerated(action.action.value.button) };
    case "drag":
      return {
        kind: "drag",
        path: action.action.value.path.map(coordinateFromGenerated),
        button: slateMouseButtonFromGenerated(action.action.value.button),
        ...(action.action.value.modifierKeys === undefined ? {} : { modifierKeys: action.action.value.modifierKeys }),
      };
    case "scroll":
      return {
        kind: "scroll",
        ...(action.action.value.coordinate === undefined ? {} : { coordinate: coordinateFromGenerated(action.action.value.coordinate) }),
        direction: slateScrollDirectionFromGenerated(action.action.value.direction),
        amount: action.action.value.amount,
        ...(action.action.value.modifierKeys === undefined ? {} : { modifierKeys: action.action.value.modifierKeys }),
      };
    case "type":
      return { kind: "type", text: action.action.value.text };
    case "key":
      return {
        kind: "key",
        key: action.action.value.key,
        ...(action.action.value.holdDurationMs === undefined ? {} : { holdDurationMs: action.action.value.holdDurationMs }),
      };
    case "wait":
      return { kind: "wait", durationMs: action.action.value.durationMs };
    case "screenshot":
      return { kind: "screenshot" };
    case "cursorPosition":
      return { kind: "cursor-position" };
    case undefined:
      return { kind: "missing" };
  }
}

function slateComputerUseRequestFromGenerated(args: ComputerUseArgs): SlateComputerUseExecutorRequest {
  return {
    toolCallId: args.toolCallId,
    actions: args.actions.map(slateActionFromGenerated),
    ...(args.description === undefined ? {} : { description: args.description }),
    ...(args.bindUnmappedCharacters === undefined ? {} : { bindUnmappedCharacters: args.bindUnmappedCharacters }),
  };
}

function generatedComputerUseResultFromSlate(result: SlateComputerUseResult): GeneratedComputerUseResult {
  if (result.kind === "success") {
    return new GeneratedComputerUseResultClass({ result: {
      case: "success",
      value: new ComputerUseSuccess({
        actionCount: result.actionCount,
        durationMs: result.durationMs,
        ...(result.screenshot === undefined ? {} : { screenshot: result.screenshot }),
        ...(result.log === undefined ? {} : { log: result.log }),
        ...(result.screenshotPath === undefined ? {} : { screenshotPath: result.screenshotPath }),
        ...(result.cursorPosition === undefined ? {} : { cursorPosition: coordinateToGenerated(result.cursorPosition) }),
      }),
    } });
  }
  if (result.kind === "error") {
    return new GeneratedComputerUseResultClass({ result: {
      case: "error",
      value: new ComputerUseError({
        error: result.message,
        actionCount: result.actionCount,
        durationMs: result.durationMs,
        ...(result.log === undefined ? {} : { log: result.log }),
        ...(result.screenshot === undefined ? {} : { screenshot: result.screenshot }),
        ...(result.screenshotPath === undefined ? {} : { screenshotPath: result.screenshotPath }),
      }),
    } });
  }
  return new GeneratedComputerUseResultClass();
}

/** Reads the generated executor result into Slate's action outcome without dropping diagnostics. */
function readGeneratedResult(result: GeneratedComputerUseResult): SlateComputerUseResult {
  if (result?.result?.case === "success" && result.result.value != null) {
    const value = result.result.value;
    return {
      kind: "success",
      actionCount: value.actionCount,
      durationMs: value.durationMs,
      ...(value.screenshot === undefined ? {} : { screenshot: value.screenshot }),
      ...(value.log === undefined ? {} : { log: value.log }),
      ...(value.screenshotPath === undefined ? {} : { screenshotPath: value.screenshotPath }),
      ...(value.cursorPosition === undefined ? {} : { cursorPosition: { x: value.cursorPosition.x, y: value.cursorPosition.y } }),
    };
  }
  if (result?.result?.case === "error" && result.result.value != null) {
    const value = result.result.value;
    return {
      kind: "error",
      message: value.error,
      actionCount: value.actionCount,
      durationMs: value.durationMs,
      ...(value.log === undefined ? {} : { log: value.log }),
      ...(value.screenshot === undefined ? {} : { screenshot: value.screenshot }),
      ...(value.screenshotPath === undefined ? {} : { screenshotPath: value.screenshotPath }),
    };
  }
  return { kind: "unknown" };
}

export interface ComputerUseExecutorPort {
  execute(context: unknown, args: SlateComputerUseExecutorRequest): Promise<SlateComputerUseResult>;
}

/** Reads the Slate executor resource from an accessor supplied by a runner or box. */
export function computerUseExecutorFromResource(resourceAccessor: { get(resource: unknown): unknown }): ComputerUseExecutorPort {
  const candidate = resourceAccessor.get(computerUseExecutorResource);
  if (candidate === null || typeof candidate !== "object" || typeof (candidate as { execute?: unknown }).execute !== "function") {
    throw new TypeError("computer-use executor resource is unavailable");
  }
  const executor = candidate as Executor<SlateComputerUseExecutorRequest, SlateComputerUseResult>;
  return {
    execute(context, args) { return executor.execute(context as Context, args); },
  };
}

export interface ScreenshotBox {
  ensureReady(context: Context, agentId: string): Promise<{ remoteAccessor?: unknown }>
}

/** Requests one desktop image and returns only the image field needed by the host handoff. */
export async function captureComputerUseScreenshot(
  box: ScreenshotBox,
  context: Context,
  agentId: string,
): Promise<string | null> {
  const connection = await box.ensureReady(context, agentId)
  const accessor = connection.remoteAccessor as ResourceAccessor<RemoteExecManager> | undefined
  if (accessor == null) return null

  const response = await computerUseExecutorFromResource(accessor).execute(context, {
    toolCallId: "",
    actions: [{ kind: "screenshot" }],
  })
  return response.kind === "success" ? response.screenshot ?? null : null
}
