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
  type ComputerUseResult as GeneratedComputerUseResult,
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
import type { ComputerProtocolAction, ComputerToolDependencies, ComputerUseResult } from "../../../host/runner/tools/slate-computer-tool.ts"

/** Binds generated computer-use request/result messages to the executor registry. */
export const computerUseExecutorResource = createResource<
  Executor<ComputerUseArgs, GeneratedComputerUseResult>,
  RemoteExecManager,
  ControlledExecManager
>(
  (execManager) => new ExecutorResource(
    execManager,
    createServerSerializer("computerUseArgs"),
    createClientDeserializer("computerUseResult"),
  ),
  (implementation, controlledExecManager) => controlledExecManager.register(
    new SimpleControlledExecHandler(
      implementation,
      createServerDeserializer("computerUseArgs"),
      createClientSerializer("computerUseResult"),
    ),
  ),
)

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

export interface ComputerUseExecutorPort {
  execute(context: unknown, args: Parameters<ComputerToolDependencies["execute"]>[1]): Promise<ComputerUseResult>;
}

/** Reads the generated executor resource through Slate's computer-use request and result shapes. */
export function computerUseExecutorFromResource(resourceAccessor: { get(resource: unknown): unknown }): ComputerUseExecutorPort {
  const executor = resourceAccessor.get(computerUseExecutorResource) as Executor<ComputerUseArgs, GeneratedComputerUseResult>;
  return {
    async execute(context, args) {
      const result = await executor.execute(context as Context, toGeneratedComputerUseArgs(args));
      return readGeneratedResult(result);
    },
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

  const executor = accessor.get(computerUseExecutorResource) as Executor<ComputerUseArgs, GeneratedComputerUseResult>
  const response = await executor.execute(context, new ComputerUseArgs({
    actions: [
      new ComputerUseAction({
        action: { case: "screenshot", value: new ScreenshotAction({}) },
      }),
    ],
  }))
  if (response.result.case !== "success") return null
  return response.result.value.screenshot ?? null
}
