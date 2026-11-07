/**
 * The tool an agent drives a computer with.
 *
 * What the agent asks for is carried to the box's desktop — clicking, typing, reading the screen — and what comes back
 * is what the desktop answered, with the monitor the agent was given so it does not drive another's.
 */
import { Buffer } from "node:buffer";
import { buildHostShellArgs } from "../../../adapters/interop/agent/box-shell-command-adapter.ts";
import { navigationProbeCommand } from "../slate-action-audit.ts";
import { SLATE_BOX_NO_MONITOR_AVAILABLE_MESSAGE } from "../../ports/box.ts";
import { shellExecutorResource } from "../../../packages/agent-exec/shell.ts";
import type { ResourceAccessor } from "../../../packages/agent-exec/resource-provider.ts";
import type { RemoteExecManager } from "../../../packages/agent-exec/executor-resources.ts";
import type { Context } from "../../../packages/context/context.ts";
import type {
  SlateComputerUseAction,
  SlateComputerUseExecutorRequest,
  SlateComputerUseExecutorResult,
} from "../../../packages/agent/conversation-step-state.ts";
import { z } from "zod";
import {
  isSlateComputerAutoReviewBypassAction,
  runSlateComputerAutoReviewPreflight,
  SLATE_COMPUTER_PAGE_STATE_CHROME_UNREACHABLE,
  computeSlateComputerPageStateIdentity,
  SlateComputerAutoReviewBlockedError,
  type SlateComputerAutoReviewOptions,
  type BoxIdentity,
} from "../slate-computer-auto-review.ts";
import type { SlateAutoReviewMode } from "../slate-auto-review.ts";
import { SlateToolInputError } from "./tool-input-error.ts";

/** Slate's supported pointer buttons, in the names accepted by its computer tool. */
export const MOUSE_BUTTONS = { left: "left", right: "right", middle: "middle" } as const;

/** Slate's supported wheel directions, in the names accepted by its computer tool. */
export const SCROLL_DIRECTIONS = { up: "up", down: "down", left: "left", right: "right" } as const;

/** The longest a wait action may ask the box to wait. */
export const SLATE_COMPUTER_MAX_WAIT_MS = 30_000;

/** The most follow-up actions one computer call may carry. */
export const SLATE_COMPUTER_MAX_FOLLOW_UP_ACTIONS = 9;

/** The actions a computer call can name, in the order the tool documents them. */
export const COMPUTER_ACTIONS = ["screenshot", "click", "move", "drag", "type", "key", "scroll", "wait"] as const;

/** The name of one computer action. */
export type ComputerActionName = typeof COMPUTER_ACTIONS[number];

/** What one computer action asks the desktop to do. */
export interface ComputerActionArgs {
  readonly [key: string]: unknown;
  readonly action: ComputerActionName;
  readonly x?: number;
  readonly y?: number;
  readonly x2?: number;
  readonly y2?: number;
  readonly path?: readonly { readonly x: number; readonly y: number }[];
  readonly text?: string;
  readonly key?: string;
  readonly button?: keyof typeof MOUSE_BUTTONS;
  readonly count?: number;
  readonly direction?: keyof typeof SCROLL_DIRECTIONS;
  readonly amount?: number;
  readonly durationMs?: number;
  readonly description?: string;
  readonly then?: readonly ComputerActionArgs[];
}

/** The message both the schema and the converter give when a drag names no way to drag. */
const DRAG_PATH_REQUIRED = "Drag requires x, y, x2, and y2 or a path with at least 2 points.";

/** The message the enforcing schema gives when a click or drag explains nothing. */
const CLICK_DRAG_DESCRIPTION_REQUIRED = "Click and drag require description: a concise statement of the intended UI target and purpose.";

/** The shortest click count an action may ask for, and the longest. */
const MIN_CLICK_COUNT = 1;
const MAX_CLICK_COUNT = 3;

/** The executor can carry signed 32-bit coordinates and amounts without narrowing. */
const MIN_COMPUTER_INT32 = -2_147_483_648;
const MAX_COMPUTER_INT32 = 2_147_483_647;
const computerInt32 = z.number().int().min(MIN_COMPUTER_INT32).max(MAX_COMPUTER_INT32);

/** One whole coordinate, which an action may leave out. */
const optionalInteger = computerInt32.optional();

/** One point of a drag path, which an action must give both sides of. */
const pathPoint = z.object({ x: computerInt32, y: computerInt32 });

/** The fields every computer action carries, whatever action it names. */
const actionCoreShape = {
  action: z.enum(COMPUTER_ACTIONS),
  x: optionalInteger, y: optionalInteger,
  x2: optionalInteger, y2: optionalInteger,
  path: z.array(pathPoint).optional(),
  text: z.string().optional(), key: z.string().optional(),
  button: z.enum(Object.keys(MOUSE_BUTTONS) as [keyof typeof MOUSE_BUTTONS, ...(keyof typeof MOUSE_BUTTONS)[]]).optional(),
  count: z.number().int().min(MIN_CLICK_COUNT).max(MAX_CLICK_COUNT).optional(),
  direction: z.enum(Object.keys(SCROLL_DIRECTIONS) as [keyof typeof SCROLL_DIRECTIONS, ...(keyof typeof SCROLL_DIRECTIONS)[]]).optional(),
  amount: computerInt32.optional(),
  durationMs: z.number().int().min(0).max(SLATE_COMPUTER_MAX_WAIT_MS).optional(),
};

/** Whether a drag names a path that can be dragged at all. */
function hasDragPath(args: z.infer<z.ZodObject<typeof actionCoreShape>>): boolean {
  return args.path != null && args.path.length >= 2;
}

/** Whether a drag names both of its corners. */
function hasDragCorners(args: z.infer<z.ZodObject<typeof actionCoreShape>>): boolean {
  return args.x != null && args.y != null && args.x2 != null && args.y2 != null;
}

/** Refuses a drag that names neither a path nor both corners. */
function validateAction(args: z.infer<z.ZodObject<typeof actionCoreShape>>, ctx: z.RefinementCtx): void {
  if (args.action === "drag" && !hasDragPath(args) && !hasDragCorners(args)) {
    ctx.addIssue({ code: "custom", message: DRAG_PATH_REQUIRED });
  }
}

/** The schema for one action, restricted to the actions a caller allows. */
export function buildComputerActionCoreSchema(actions: readonly [ComputerActionName, ...ComputerActionName[]] = COMPUTER_ACTIONS) {
  return z.object({ ...actionCoreShape, action: z.enum(actions) }).superRefine(validateAction);
}

/** The actions that may follow the first one: everything a computer call may do except the screenshot itself. */
const FOLLOW_UP_ACTIONS = COMPUTER_ACTIONS.filter((action) => action !== "screenshot") as [ComputerActionName, ...ComputerActionName[]];

/** The follow-up actions auto-review wants a description for, when it enforces descriptions. */
const REVIEWABLE_FOLLOW_UP_ACTIONS = FOLLOW_UP_ACTIONS.filter(isSlateComputerAutoReviewBypassAction) as [ComputerActionName, ...ComputerActionName[]];

/** Whether the state is in the mode that enforces descriptions. */
function enforcesDescription(autoReview?: { readonly mode: SlateAutoReviewMode }): boolean {
  return autoReview?.mode === "enforce";
}

/** The message the enforcing schema gives when a click or drag explains nothing. */
function needsDescription(args: { readonly action: string; readonly description?: string | undefined }): boolean {
  return (args.action === "click" || args.action === "drag") && !args.description?.trim();
}

/** The parameters of a computer call: the first action, the follow-ups auto-review allows and the call's description. */
export function buildComputerParameters(autoReview?: { readonly mode: SlateAutoReviewMode }) {
  const allowed = enforcesDescription(autoReview) ? REVIEWABLE_FOLLOW_UP_ACTIONS : FOLLOW_UP_ACTIONS;
  return z.object({
    ...actionCoreShape,
    then: z.array(buildComputerActionCoreSchema(allowed)).min(1).max(SLATE_COMPUTER_MAX_FOLLOW_UP_ACTIONS).optional(),
    description: z.string().optional(),
  }).superRefine((args, ctx) => {
    validateAction(args, ctx);
    if (enforcesDescription(autoReview) && needsDescription(args)) {
      ctx.addIssue({ code: "custom", path: ["description"], message: CLICK_DRAG_DESCRIPTION_REQUIRED });
    }
  });
}

/** The parameters of the computer tool a caller can use without a mode. */
export const computerActionParameters = buildComputerParameters();

/** The parameters of the screenshot tool, which takes nothing. */
export const screenshotParameters = z.object({});

/** The exact action that was asked for, without the description and the follow-ups. */
export function toExactActionArgs(asked: ComputerActionArgs): ComputerActionArgs {
  const { description: _askedForDescription, then: _askedForFollowUps, ...exact } = asked;
  return exact;
}

/** The drag path an action names: its path, its two corners, or nothing. */
export function dragPath(asked: ComputerActionArgs): readonly { x: number; y: number }[] | undefined {
  if (asked.path != null && asked.path.length >= 2) return asked.path;
  if (asked.x == null || asked.y == null || asked.x2 == null || asked.y2 == null) return undefined;
  return [{ x: asked.x, y: asked.y }, { x: asked.x2, y: asked.y2 }];
}

/** One point an action names, when it names both sides. */
function coordinateOf(x: number | undefined, y: number | undefined): { x: number; y: number } | undefined {
  return x == null || y == null ? undefined : { x, y };
}

/** The Slate button a mouse action names. */
function mouseButtonOf(asked: ComputerActionArgs): keyof typeof MOUSE_BUTTONS {
  return asked.button ?? "left";
}

/** The Slate direction a scroll names. */
function scrollDirectionOf(asked: ComputerActionArgs): keyof typeof SCROLL_DIRECTIONS {
  return asked.direction ?? "down";
}

/** One parsed tool action as a Slate-owned computer-use value. */
export function toAction(asked: ComputerActionArgs): SlateComputerUseAction<string> | undefined {
  switch (asked.action) {
    case "screenshot":
      return { kind: "screenshot" };
    case "click": {
      const coordinate = coordinateOf(asked.x, asked.y);
      return {
        kind: "click",
        ...(coordinate === undefined ? {} : { coordinate }),
        button: mouseButtonOf(asked),
        count: asked.count ?? 1,
      };
    }
    case "move": {
      const coordinate = coordinateOf(asked.x, asked.y);
      return { kind: "mouse-move", ...(coordinate === undefined ? {} : { coordinate }) };
    }
    case "drag": {
      const path = dragPath(asked);
      if (path == null) throw new SlateToolInputError(DRAG_PATH_REQUIRED);
      return { kind: "drag", path, button: mouseButtonOf(asked) };
    }
    case "type":
      return { kind: "type", text: asked.text ?? "" };
    case "key":
      return { kind: "key", key: asked.key ?? "" };
    case "scroll": {
      const coordinate = coordinateOf(asked.x, asked.y);
      return {
        kind: "scroll",
        ...(coordinate === undefined ? {} : { coordinate }),
        direction: scrollDirectionOf(asked),
        amount: asked.amount ?? 3,
      };
    }
    case "wait":
      return { kind: "wait", durationMs: asked.durationMs ?? 1_000 };
  }
  return undefined;
}

function requiredSlateAction(asked: ComputerActionArgs): SlateComputerUseAction<string> {
  const action = toAction(asked);
  if (action === undefined) throw new SlateToolInputError(`Unsupported computer action: ${String(asked.action)}`);
  return action;
}

/** What a turn reports about the desktop: where the pointer went, if it went anywhere. */
export type ReportedComputerAction =
  | { readonly type: "drag" | "move" | "scroll"; readonly x: number; readonly y: number }
  | { readonly type: "click"; readonly x: number; readonly y: number; readonly button: string; readonly count: number };

/** The point a drag starts from, when the drag names one. */
function dragStart(asked: ComputerActionArgs): { x: number; y: number } | undefined {
  return dragPath(asked)?.[0];
}

/** The point a move or scroll works at, when the action names one. */
function actionPoint(asked: ComputerActionArgs): { x: number; y: number } | undefined {
  return coordinateOf(asked.x, asked.y);
}

/** What one action tells the turn about the desktop, when it tells anything. */
export function toReportedAction(asked: ComputerActionArgs): ReportedComputerAction | undefined {
  switch (asked.action) {
    case "drag": {
      const start = dragStart(asked);
      return start == null ? undefined : { type: "drag", x: start.x, y: start.y };
    }
    case "move":
    case "scroll": {
      const point = actionPoint(asked);
      return point == null ? undefined : { type: asked.action, x: point.x, y: point.y };
    }
    case "click": {
      const point = actionPoint(asked);
      return point == null ? undefined : {
        type: "click", x: point.x, y: point.y, button: asked.button ?? "left", count: asked.count ?? 1,
      };
    }
    default:
      return undefined;
  }
}

/** The first place a batch of actions reported that is not a drag, or the first place at all. */
export function reportedBatchPosition(batch: readonly ComputerActionArgs[]): ReportedComputerAction | undefined {
  const positions = batch.flatMap((asked) => toReportedAction(asked) ?? []);
  return positions.find((position) => position.type !== "drag") ?? positions[0];
}

/** What a computer call answers with, in Slate's result vocabulary. */
export type SlateComputerUseResult = SlateComputerUseExecutorResult;

/** The line a failed call is described with. */
function describeFailure(result: Extract<SlateComputerUseResult, { readonly kind: "error" }>, operation: "screenshot" | "computer"): string {
  const label = operation === "screenshot" ? "Screenshot" : "Computer action";
  return `${label} failed: ${result.message}`;
}

/** The heading a call is described with. */
function describeHeading(operation: "screenshot" | "computer"): string {
  return operation === "screenshot" ? "Screenshot captured from the box desktop." : "Computer action ran on the box desktop.";
}

/** The lines a success adds after its heading: where the image went and where the cursor is. */
function describeSuccess(result: Extract<SlateComputerUseResult, { readonly kind: "success" }>, heading: string): string[] {
  const lines = [heading];
  if (result.screenshotPath != null && result.screenshotPath.length > 0) lines.push(`Screenshot saved to ${result.screenshotPath}.`);
  if (result.cursorPosition != null) lines.push(`Cursor is at (${result.cursorPosition.x}, ${result.cursorPosition.y}).`);
  return lines;
}

/** What a computer call's renderer tells the model about its outcome. */
export function describeOutcome(result: SlateComputerUseResult, operation: "screenshot" | "computer"): string {
  if (result.kind === "error") return describeFailure(result, operation);
  const heading = describeHeading(operation);
  if (result.kind !== "success") return heading;
  return describeSuccess(result, heading).join("\n");
}

/** What the box tools need from the runner: a resource accessor, an executor, image persistence and the review options. */
export interface ComputerToolDependencies<Context = unknown> {
  readonly resourceAccessor: { get(resource: unknown): unknown };
  execute(context: Context, args: SlateComputerUseExecutorRequest): Promise<SlateComputerUseResult>;
  getPersistImage(): ((bytes: Uint8Array, mimeType: string) => Promise<{ readonly fileUrl: string } | undefined>) | undefined;
  isUnicodeTypingEnabled?(): boolean;
  onComputerAction?(action: ReportedComputerAction): void;
  autoReview?: SlateComputerAutoReviewOptions;
}

/** The message given when auto-review cannot resolve the monitor it should look at. */
const DISPLAY_UNKNOWN_MESSAGE = "Computer Auto-review could not identify this agent's own display; retry once the box desktop is ready.";

/** The two messages given when auto-review cannot capture the page state. */
const PAGE_STATE_UNCAPTURED_MESSAGE = "Computer Auto-review could not capture the current page state.";

/** The executor that answers a shell resource accessor. */
type ShellExecutor = { execute(ctx: Context, args: unknown): Promise<any> };

/** The monitor the agent was given, resolved through the runner or refused for auto-review. */
async function resolveDisplayNumberForReview(
  ctx: Context,
  resolveDisplayNumber: (ctx: Context) => Promise<number | undefined>,
): Promise<number> {
  let displayNumber: number | undefined;
  try {
    displayNumber = await resolveDisplayNumber(ctx);
  } catch {
    throw new SlateComputerAutoReviewBlockedError(DISPLAY_UNKNOWN_MESSAGE);
  }
  if (displayNumber === undefined) throw new SlateComputerAutoReviewBlockedError(SLATE_BOX_NO_MONITOR_AVAILABLE_MESSAGE);
  return displayNumber;
}

/** The current page's identity, read from the box's own shell. */
async function captureDisplayStateIdentity(
  ctx: Context,
  resourceAccessor: ResourceAccessor<RemoteExecManager>,
  toolCallId: string,
  resolveDisplayNumber: (ctx: Context) => Promise<number | undefined>,
): Promise<string> {
  const displayNumber = await resolveDisplayNumberForReview(ctx, resolveDisplayNumber);
  let result: any;
  try {
    result = await (resourceAccessor.get(shellExecutorResource) as ShellExecutor).execute(
      ctx,
      buildHostShellArgs({
        command: navigationProbeCommand(displayNumber),
        name: "curl",
        workingDirectory: "/workspace",
        toolCallId: `${toolCallId}:auto-review-state`,
      }),
    );
  } catch {
    throw new SlateComputerAutoReviewBlockedError(PAGE_STATE_UNCAPTURED_MESSAGE);
  }
  if (result?.result?.case !== "success") throw new SlateComputerAutoReviewBlockedError(PAGE_STATE_UNCAPTURED_MESSAGE);
  if (result.result.value.exitCode !== 0) return SLATE_COMPUTER_PAGE_STATE_CHROME_UNREACHABLE;
  return computeSlateComputerPageStateIdentity(result.result.value.stdout ?? "");
}

/** Saves the screenshot a successful call captured, when the runner has somewhere to save it. */
async function persistScreenshot(
  success: Extract<SlateComputerUseResult, { readonly kind: "success" }>,
  deps: ComputerToolDependencies<unknown>,
): Promise<Extract<SlateComputerUseResult, { readonly kind: "success" }>> {
  if (success.screenshot == null || success.screenshot.length === 0) return success;
  const saved = await deps.getPersistImage()?.(Buffer.from(success.screenshot, "base64"), "image/webp");
  return saved == null ? success : { ...success, screenshotPath: saved.fileUrl };
}

/** Runs a computer call, then saves the screenshot it captured. */
export async function executeAndPersistComputerUse<Context>(context: Context, deps: ComputerToolDependencies<Context>, args: Parameters<ComputerToolDependencies<Context>["execute"]>[1]): Promise<SlateComputerUseResult> {
  const result = await deps.execute(context, args);
  return result.kind === "success"
    ? await persistScreenshot(result, deps as ComputerToolDependencies<unknown>)
    : result;
}

/** The screenshot tool: one screenshot of the agent's own monitor, saved when the runner can save it. */
export function createScreenshotTool<Context>(deps: ComputerToolDependencies<Context>) {
  return {
    id: "OPENAI_COMPUTER_USE", name: "Screenshot", parameters: screenshotParameters,
    async execute(_args: Record<string, never>, meta: { context: Context; toolCallId?: string }): Promise<SlateComputerUseResult> {
      return executeAndPersistComputerUse(meta.context, deps, {
        toolCallId: meta.toolCallId ?? "",
        actions: [requiredSlateAction({ action: "screenshot" })],
      });
    },
    render: (output: SlateComputerUseResult) => ({ content: describeOutcome(output, "screenshot") }),
  };
}

/** The action a computer call starts with and the follow-ups it carries, as one sequence. */
function actionSequence(parsed: ComputerActionArgs): ComputerActionArgs[] {
  const { then, ...primary } = parsed;
  return [primary, ...(then ?? [])];
}

/** The preflight a reviewed computer call runs, with the review options and the page-state capture wired in. */
function preflightFor(meta: { context: Context; toolCallId?: string; signal?: AbortSignal; stateHandler?: unknown; workspacePaths?: readonly string[] }, deps: ComputerToolDependencies<unknown>, parsed: ComputerActionArgs, autoReview: SlateComputerAutoReviewOptions): Parameters<typeof runSlateComputerAutoReviewPreflight>[0] {
  return {
    ctx: meta.context as unknown as import("../../../packages/context/context.ts").Context,
    resourceAccessor: deps.resourceAccessor as ResourceAccessor<RemoteExecManager>,
    exactAction: toExactActionArgs(parsed),
    ...(parsed.description == null ? {} : { description: parsed.description }),
    toolCallId: meta.toolCallId ?? "",
    ...(meta.stateHandler === undefined ? {} : { stateHandler: meta.stateHandler }),
    ...(meta.workspacePaths === undefined ? {} : { workspacePaths: meta.workspacePaths }),
    ...(meta.signal == null ? {} : { signal: meta.signal }),
    options: {
      ...autoReview,
      captureDisplayStateIdentity: (ctx, toolCallId) => captureDisplayStateIdentity(
        ctx,
        deps.resourceAccessor as ResourceAccessor<RemoteExecManager>,
        toolCallId,
        autoReview.resolveDisplayNumber,
      ),
    },
  } as Parameters<typeof runSlateComputerAutoReviewPreflight>[0];
}

/** The computer tool: the agent's actions, ending in a screenshot unless it asked for one. */
export function createComputerTool<Context>(deps: ComputerToolDependencies<Context>) {
  const parameters = buildComputerParameters(deps.autoReview);
  return {
    id: "OPENAI_COMPUTER_USE", name: "Computer", parameters,
    async execute(raw: unknown, meta: { context: Context; toolCallId?: string; signal?: AbortSignal; stateHandler?: unknown; workspacePaths?: readonly string[] }): Promise<SlateComputerUseResult> {
      const parsed = parameters.parse(raw) as ComputerActionArgs;
      const sequence = actionSequence(parsed);
      const actions = sequence.map(requiredSlateAction);
      if (sequence.at(-1)?.action !== "screenshot") actions.push(requiredSlateAction({ action: "screenshot" }));
      const autoReview = deps.autoReview;
      if (autoReview != null) {
        await runSlateComputerAutoReviewPreflight(preflightFor(meta as never, deps as ComputerToolDependencies<unknown>, parsed, autoReview));
      }
      const reported = reportedBatchPosition(sequence);
      if (reported != null) deps.onComputerAction?.(reported);
      const description = parsed.description?.trim();
      return executeAndPersistComputerUse(meta.context, deps, {
        toolCallId: meta.toolCallId ?? "", actions,
        ...(deps.isUnicodeTypingEnabled?.() === true ? { bindUnmappedCharacters: true } : {}),
        ...(description == null || description.length === 0 ? {} : { description }),
      });
    },
    render: (output: SlateComputerUseResult) => ({ content: describeOutcome(output, "computer") }),
  };
}
