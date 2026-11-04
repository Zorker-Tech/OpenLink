/**
 * The tools an agent drives a browser with.
 *
 * What the agent asks for — navigating, reading a page, clicking, filling, screenshotting — is carried to the driverClient
 * running in the page, and what comes back is what the page answered.
 */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { buildHostShellArgs } from "../../../adapters/interop/agent/box-shell-command-adapter.ts";
import { navigationProbeCommand, normalizeNavigationUrl, parseNavigationProbeOutput } from "../slate-action-audit.ts";
import { SLATE_BOX_NO_MONITOR_AVAILABLE_MESSAGE } from "../../ports/box.ts";
import { shellExecutorResource } from "../../../packages/agent-exec/shell.ts";
import type { ResourceAccessor } from "../../../packages/agent-exec/resource-provider.ts";
import type { RemoteExecManager } from "../../../packages/agent-exec/executor-resources.ts";
import type { Context as OperationContext } from "../../../packages/context/context.ts";
import {
  runSlateBrowserAutoReviewPreflight,
  SlateBrowserAutoReviewBlockedError,
  type SlateBrowserAutoReviewOptions,
} from "../slate-browser-auto-review.ts";
import {
  SLATE_BROWSER_DRIVER_BOX_DIR,
  SLATE_BROWSER_DRIVER_BOX_PATH,
  SLATE_BROWSER_DRIVER_SOURCE,
  SLATE_BROWSER_RESULT_MARKER,
} from "../../../adapters/interop/browser/browser-driver-source-adapter.ts";

export const BOX_CDP_PORT_BASE = 9_222;
export const PENDING_SCREENSHOT_CAP = 32;

const stashedShots = new Map<string, string>();

export function stashScreenshot(imageB64: string): string {
  const key = `shot-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  if (stashedShots.size >= PENDING_SCREENSHOT_CAP) {
    const oldestKey = stashedShots.keys().next().value;
    if (oldestKey !== undefined) stashedShots.delete(oldestKey);
  }
  stashedShots.set(key, imageB64);
  return key;
}

export interface BrowserEnvelope {
  readonly text: string;
  readonly imageKey?: string;
}

export function encodeEnvelope(envelope: BrowserEnvelope): string {
  return JSON.stringify(envelope);
}

export function decodeEnvelope(raw: string): BrowserEnvelope {
  try {
    const parsedValue: unknown = JSON.parse(raw);
    if (
      typeof parsedValue === "object"
      && parsedValue !== null
      && "text" in parsedValue
      && typeof parsedValue.text === "string"
    ) {
      return {
        text: parsedValue.text,
        ...(
          "imageKey" in parsedValue && typeof parsedValue.imageKey === "string"
            ? { imageKey: parsedValue.imageKey }
            : {}
        ),
      };
    }
  } catch {}
  return { text: raw };
}

export interface BrowserDriverResponse {
  readonly ok: boolean;
  readonly error?: string | undefined;
  readonly summary?: string | undefined;
  readonly data?: string | undefined;
  readonly url?: string | undefined;
  readonly title?: string | undefined;
  readonly viewId?: string | undefined;
  readonly screenshot?: boolean | undefined;
}

function stringFieldOf(
  object: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = object[key];
  return typeof value === "string" ? value : undefined;
}

function booleanFieldOf(
  object: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = object[key];
  return typeof value === "boolean" ? value : undefined;
}

export function toDriverResponse(
  parsedValue: Record<string, unknown>,
): BrowserDriverResponse {
  return {
    ok: booleanFieldOf(parsedValue, "ok") ?? false,
    ...(stringFieldOf(parsedValue, "error") == null
      ? {}
      : { error: stringFieldOf(parsedValue, "error") }),
    ...(stringFieldOf(parsedValue, "summary") == null
      ? {}
      : { summary: stringFieldOf(parsedValue, "summary") }),
    ...(stringFieldOf(parsedValue, "data") == null
      ? {}
      : { data: stringFieldOf(parsedValue, "data") }),
    ...(stringFieldOf(parsedValue, "url") == null
      ? {}
      : { url: stringFieldOf(parsedValue, "url") }),
    ...(stringFieldOf(parsedValue, "title") == null
      ? {}
      : { title: stringFieldOf(parsedValue, "title") }),
    ...(stringFieldOf(parsedValue, "viewId") == null
      ? {}
      : { viewId: stringFieldOf(parsedValue, "viewId") }),
    ...(booleanFieldOf(parsedValue, "screenshot") == null
      ? {}
      : { screenshot: booleanFieldOf(parsedValue, "screenshot") }),
  };
}

export function parseDriverResponse(
  stdout: string,
): BrowserDriverResponse | undefined {
  const lines = stdout.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? "";
    const markerAt = line.indexOf(SLATE_BROWSER_RESULT_MARKER);
    if (markerAt < 0) continue;
    try {
      const parsedValue: unknown = JSON.parse(
        line.slice(markerAt + SLATE_BROWSER_RESULT_MARKER.length),
      );
      if (
        typeof parsedValue === "object"
        && parsedValue !== null
        && !Array.isArray(parsedValue)
      ) {
        return toDriverResponse(parsedValue as Record<string, unknown>);
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function sanitizeForBoxPath(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48);
  return sanitized.length > 0 ? sanitized : `call-${Date.now()}`;
}

export class SlateBrowserDriverError extends Error {
  override readonly name = "SlateBrowserDriverError";
}

export interface BrowserDriverDependencies<Context> {
  readonly resourceAccessor: { get(resource: unknown): unknown };
  getWindowIndex(browserCtx: Context): Promise<number | undefined>;
  getBoxId(): string;
  getDefaultViewId(): string;
  uploadFile(
    browserCtx: Context,
    boxId: string,
    path: string,
    fileBytes: Uint8Array,
  ): Promise<void>;
  downloadFile(
    browserCtx: Context,
    boxId: string,
    path: string,
  ): Promise<Uint8Array>;
  executeShell(
    browserCtx: Context,
    input: {
      command: string;
      name: string;
      workingDirectory: string;
      toolCallId: string;
    },
  ): Promise<{
    readonly case: "success" | string;
    readonly stdout?: string;
    readonly stderr?: string;
    readonly exitCode?: number;
  }>;
  getPersistImage?():
    | ((fileBytes: Uint8Array, mimeType: string) => Promise<unknown>)
    | undefined;
  readonly autoReview?: SlateBrowserAutoReviewOptions;
}

export interface BrowserDriverOutput {
  readonly text: string;
  readonly imageB64?: string;
  readonly isError?: boolean;
}

export class SlateBrowserDriver<Context = unknown> {
  #uploaded: Promise<void> | undefined;
  #windowIndex: Promise<number> | undefined;

  constructor(readonly ports: BrowserDriverDependencies<Context>) {}

  windowIndexFor(browserCtx: Context): Promise<number> {
    this.#windowIndex ??= this.ports.getWindowIndex(browserCtx)
      .then((index) => {
        if (index === undefined) {
          this.#windowIndex = undefined;
          throw new SlateBrowserDriverError(
            "The box has not assigned this agent a browser window yet; try again in a moment.",
          );
        }
        return index;
      })
      .catch((error: unknown) => {
        this.#windowIndex = undefined;
        throw error instanceof SlateBrowserDriverError
          ? error
          : new SlateBrowserDriverError(
            `Could not resolve this agent's browser window: ${error instanceof Error ? error.message : String(error)}`,
          );
      });
    return this.#windowIndex;
  }

  ensureDriverUploaded(browserCtx: Context): Promise<void> {
    this.#uploaded ??= this.ports.uploadFile(
      browserCtx,
      this.ports.getBoxId(),
      SLATE_BROWSER_DRIVER_BOX_PATH,
      Buffer.from(SLATE_BROWSER_DRIVER_SOURCE, "utf8"),
    ).catch((error: unknown) => {
      this.#uploaded = undefined;
      throw new SlateBrowserDriverError(
        `Could not install the browser driver on the box: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    return this.#uploaded;
  }

  async run(
    browserCtx: Context,
    input: {
      readonly op: string;
      readonly toolCallId: string;
      readonly args: Record<string, unknown>;
      readonly skipScreenshot?: boolean;
    },
  ): Promise<BrowserDriverOutput> {
    const [windowIndex] = await Promise.all([
      this.windowIndexFor(browserCtx),
      this.ensureDriverUploaded(browserCtx),
    ]);

    const shotPath = input.skipScreenshot === true
      ? undefined
      : `${SLATE_BROWSER_DRIVER_BOX_DIR}/shot-${sanitizeForBoxPath(input.toolCallId)}.png`;
    const viewIdArg = input.args.viewId;
    const driverRequest = {
      ...input.args,
      op: input.op,
      display: windowIndex,
      cdpPort: BOX_CDP_PORT_BASE + windowIndex,
      viewId: typeof viewIdArg === "string" && viewIdArg.length > 0
        ? viewIdArg
        : this.ports.getDefaultViewId(),
      ...(shotPath == null ? {} : { shotPath }),
    };
    const encodedRequest = Buffer.from(
      JSON.stringify(driverRequest),
      "utf8",
    ).toString("base64");

    const shellRun = await this.ports.executeShell(browserCtx, {
      command: `node ${SLATE_BROWSER_DRIVER_BOX_PATH} ${encodedRequest}`,
      name: "node",
      workingDirectory: "/workspace",
      toolCallId: `slate-browser-${input.op}-${sanitizeForBoxPath(input.toolCallId)}`,
    });
    if (shellRun.case !== "success") {
      throw new SlateBrowserDriverError(
        `Browser driver shell failed (${shellRun.case || "unknown"})`,
      );
    }

    const driverReply = parseDriverResponse(shellRun.stdout ?? "");
    if (driverReply === undefined) {
      const failureDetail = [shellRun.stderr ?? "", shellRun.stdout ?? ""]
        .map((part) => part.trim().slice(-400))
        .filter((part) => part.length > 0)
        .join(" | ");
      throw new SlateBrowserDriverError(
        `Browser driver produced no result (exit ${shellRun.exitCode ?? "unknown"})${failureDetail.length > 0 ? `: ${failureDetail}` : ""}`,
      );
    }
    if (!driverReply.ok) {
      return {
        text: driverReply.error ?? "The browser action failed.",
        isError: true,
      };
    }

    const sections = [driverReply.summary ?? "Done."];
    if (driverReply.url != null && driverReply.url.length > 0) {
      sections.push(`Current page: ${driverReply.title ?? ""} (${driverReply.url})`);
    }
    if (driverReply.data != null && driverReply.data.length > 0) {
      sections.push(driverReply.data);
    }

    const imageB64 = driverReply.screenshot === true && shotPath != null
      ? await this.downloadScreenshot(browserCtx, shotPath)
      : undefined;
    return {
      text: sections.join("\n\n"),
      ...(imageB64 == null ? {} : { imageB64 }),
    };
  }

  async downloadScreenshot(
    browserCtx: Context,
    boxPath: string,
  ): Promise<string | undefined> {
    try {
      const fileBytes = await this.ports.downloadFile(
        browserCtx,
        this.ports.getBoxId(),
        boxPath,
      );
      if (fileBytes.length === 0) return undefined;
      const persistImage = this.ports.getPersistImage?.();
      if (persistImage != null) {
        await persistImage(fileBytes, "image/png").catch(() => null);
      }
      return Buffer.from(fileBytes).toString("base64");
    } catch {
      return undefined;
    }
  }
}

export interface BrowserReviewAction {
  readonly [key: string]: unknown;
  readonly op: string;
  readonly viewId: string;
  readonly url?: string | undefined;
  readonly ref?: string | undefined;
  readonly element?: string | undefined;
  readonly text?: string | undefined;
  readonly value?: string | undefined;
  readonly values?: readonly string[] | undefined;
  readonly key?: string | undefined;
  readonly cdpMethod?: string | undefined;
  readonly cdpParams?: string | undefined;
  readonly tabsAction?: string | undefined;
  readonly tabIndex?: number | undefined;
  readonly x?: number | undefined;
  readonly y?: number | undefined;
  readonly sourceRef?: string | undefined;
  readonly targetRef?: string | undefined;
  readonly targetX?: number | undefined;
  readonly targetY?: number | undefined;
  readonly newTab?: boolean | undefined;
  readonly submit?: boolean | undefined;
  readonly clear?: boolean | undefined;
  readonly doubleClick?: boolean | undefined;
  readonly button?: string | undefined;
  readonly modifiers?: readonly string[] | undefined;
}

const REVIEW_STATE_MARKER = "__SLATE_BROWSER_VIEW_STATE__";

function targetPageUrlOf(
  probeStdout: string,
  stateJson: string,
  viewId: string,
): string | undefined {
  let parsedValue: unknown;
  try { parsedValue = JSON.parse(stateJson); } catch { parsedValue = undefined; }
  const fields = parsedValue !== null && typeof parsedValue === "object" && !Array.isArray(parsedValue)
    ? parsedValue as Record<string, unknown>
    : {};
  const views = fields.views !== null && typeof fields.views === "object" && !Array.isArray(fields.views)
    ? fields.views as Record<string, unknown>
    : {};
  const urls = fields.urls !== null && typeof fields.urls === "object" && !Array.isArray(fields.urls)
    ? fields.urls as Record<string, unknown>
    : {};
  const viewTargetId = views[viewId];
  if (typeof viewTargetId === "string" && viewTargetId.length > 0) {
    const pageTarget = parseNavigationProbeOutput(probeStdout).find(candidatePage => candidatePage.type === "page" && candidatePage.id === viewTargetId);
    const url = typeof pageTarget?.url === "string" ? normalizeNavigationUrl(pageTarget.url) : undefined;
    if (url !== undefined) return url;
  }
  return typeof urls[viewId] === "string" ? normalizeNavigationUrl(urls[viewId] as string) : undefined;
}

async function captureReviewState(args: {
  readonly ctx: OperationContext;
  readonly resourceAccessor: ResourceAccessor<RemoteExecManager>;
  readonly toolCallId: string;
  readonly resolveDisplayNumber: (ctx: OperationContext) => Promise<number | undefined>;
  readonly viewId?: string;
}): Promise<{ displayStateIdentity: string; pageUrl?: string }> {
  let displayIndex: number | undefined;
  try { displayIndex = await args.resolveDisplayNumber(args.ctx); } catch {
    throw new SlateBrowserAutoReviewBlockedError("Browser Auto-review could not identify this agent's own display; retry once the box desktop is ready.");
  }
  if (displayIndex === undefined) throw new SlateBrowserAutoReviewBlockedError(SLATE_BOX_NO_MONITOR_AVAILABLE_MESSAGE);
  let result: any;
  try {
    result = await (args.resourceAccessor.get(shellExecutorResource) as { execute(ctx: OperationContext, args: unknown): Promise<any> }).execute(args.ctx, buildHostShellArgs({
      command: `${navigationProbeCommand(displayIndex)} && echo ${REVIEW_STATE_MARKER} && (cat ${SLATE_BROWSER_DRIVER_BOX_DIR}/views-${displayIndex}.json 2>/dev/null || true)`,
      name: "curl",
      workingDirectory: "/workspace",
      toolCallId: `${args.toolCallId}:auto-review-state`,
    }));
  } catch {
    throw new SlateBrowserAutoReviewBlockedError("Browser Auto-review could not capture the current page state.");
  }
  if (result?.result?.case !== "success") throw new SlateBrowserAutoReviewBlockedError("Browser Auto-review could not capture the current page state.");
  if (result.result.value.exitCode !== 0) return { displayStateIdentity: "chrome-unreachable" };
  const stdout = result.result.value.stdout ?? "";
  const markerAt = stdout.indexOf(REVIEW_STATE_MARKER);
  const probeText = markerAt >= 0 ? stdout.slice(0, markerAt) : stdout;
  const stateText = markerAt >= 0 ? stdout.slice(markerAt + REVIEW_STATE_MARKER.length) : "";
  const pageUrl = args.viewId === undefined ? undefined : targetPageUrlOf(probeText, stateText.trim(), args.viewId);
  const pageState = parseNavigationProbeOutput(probeText)
    .filter(pageTarget => pageTarget.type === "page" && typeof pageTarget.id === "string")
    .map(pageTarget => `${String(pageTarget.id)}\t${typeof pageTarget.url === "string" ? String(pageTarget.url).trim() : ""}`)
    .sort()
    .join("\n");
  return {
    displayStateIdentity: createHash("sha256").update(pageState).digest("hex"),
    ...(pageUrl === undefined ? {} : { pageUrl }),
  };
}

export function toBrowserReviewAction(
  op: string,
  args: Record<string, unknown>,
  defaultViewId: string,
): BrowserReviewAction {
  const stringValue = (key: string): string | undefined =>
    typeof args[key] === "string" ? args[key] : undefined;
  const numberValue = (key: string): number | undefined =>
    typeof args[key] === "number" ? args[key] : undefined;
  const booleanValue = (key: string): boolean | undefined =>
    typeof args[key] === "boolean" ? args[key] : undefined;
  const stringArray = (key: string): string[] | undefined =>
    Array.isArray(args[key])
      ? args[key].filter((entry): entry is string => typeof entry === "string")
      : undefined;

  return {
    op,
    viewId: stringValue("viewId") ?? defaultViewId,
    ...(stringValue("url") == null ? {} : { url: stringValue("url") }),
    ...(stringValue("ref") == null ? {} : { ref: stringValue("ref") }),
    ...(stringValue("element") == null ? {} : { element: stringValue("element") }),
    ...(stringValue("text") == null ? {} : { text: stringValue("text") }),
    ...(stringValue("value") == null ? {} : { value: stringValue("value") }),
    ...(stringArray("values") == null ? {} : { values: stringArray("values") }),
    ...(stringValue("key") == null ? {} : { key: stringValue("key") }),
    ...(op !== "cdp" || stringValue("method") == null
      ? {}
      : { cdpMethod: stringValue("method") }),
    ...(op !== "cdp" || args.params === undefined
      ? {}
      : { cdpParams: JSON.stringify(args.params) }),
    ...(op !== "tabs" || stringValue("action") == null
      ? {}
      : { tabsAction: stringValue("action") }),
    ...(op !== "tabs" || numberValue("index") == null
      ? {}
      : { tabIndex: numberValue("index") }),
    ...(numberValue("x") == null ? {} : { x: numberValue("x") }),
    ...(numberValue("y") == null ? {} : { y: numberValue("y") }),
    ...(stringValue("sourceRef") == null
      ? {}
      : { sourceRef: stringValue("sourceRef") }),
    ...(stringValue("targetRef") == null
      ? {}
      : { targetRef: stringValue("targetRef") }),
    ...(numberValue("targetX") == null
      ? {}
      : { targetX: numberValue("targetX") }),
    ...(numberValue("targetY") == null
      ? {}
      : { targetY: numberValue("targetY") }),
    ...(booleanValue("newTab") == null
      ? {}
      : { newTab: booleanValue("newTab") }),
    ...(booleanValue("submit") == null
      ? {}
      : { submit: booleanValue("submit") }),
    ...(booleanValue("clear") == null
      ? {}
      : { clear: booleanValue("clear") }),
    ...(booleanValue("doubleClick") == null
      ? {}
      : { doubleClick: booleanValue("doubleClick") }),
    ...(stringValue("button") == null
      ? {}
      : { button: stringValue("button") }),
    ...(stringArray("modifiers") == null
      ? {}
      : { modifiers: stringArray("modifiers") }),
  };
}

export interface BrowserToolSchema {
  readonly required?: readonly string[];
  readonly enum?: Readonly<Record<string, readonly string[]>>;
}

export interface BrowserToolDefinition<Context> {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly op: string;
  readonly schema: BrowserToolSchema;
  readonly canNavigate?: boolean;
  readonly skipScreenshot?: boolean;
  execute(
    browserCtx: Context,
    args: Record<string, unknown>,
    callContext: { readonly toolCallId: string; readonly stateHandler?: unknown; readonly workspacePaths?: readonly string[] },
  ): Promise<BrowserDriverOutput>;
  render(driverOutput: BrowserDriverOutput): {
    readonly kind: "text" | "image";
    readonly text: string;
    readonly imageB64?: string;
    readonly isError?: boolean;
  };
}

interface BrowserToolNote {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly op: string;
  readonly schema?: BrowserToolSchema;
  readonly canNavigate?: boolean;
  readonly skipScreenshot?: boolean;
}

const BROWSER_TOOL_NOTES: readonly BrowserToolNote[] = [
  { id: "BROWSER_NAVIGATE", name: "browser_navigate", op: "navigate", description: "Navigate the box browser to a URL. By default reuses your tab; set newTab: true to open in a new tab. Returns the resulting page state with a screenshot.", schema: { required: ["url"] }, canNavigate: true },
  { id: "BROWSER_SNAPSHOT", name: "browser_snapshot", op: "snapshot", description: "Capture a structured snapshot of the current page with [ref=eN] handles for interactive elements. This is the source of truth for page structure; refs are tied to the latest snapshot for that tab. Better than a screenshot for deciding what to click or type." },
  { id: "BROWSER_CLICK", name: "browser_click", op: "click", description: "Click an element by ref from browser_snapshot. Scrolls the element into view first.", schema: { required: ["ref"] }, canNavigate: true },
  { id: "BROWSER_MOUSE_CLICK_XY", name: "browser_mouse_click_xy", op: "mouse_click_xy", description: "Click at viewport coordinates. Prefer browser_click with refs when possible.", schema: { required: ["x", "y"] }, canNavigate: true },
  { id: "BROWSER_TYPE", name: "browser_type", op: "type", description: "Type text into an input, textarea, or contenteditable element by ref.", schema: { required: ["ref", "text"] }, canNavigate: true },
  { id: "BROWSER_FILL", name: "browser_fill", op: "fill", description: "Set the value of an input, textarea, or contenteditable element by ref.", schema: { required: ["ref", "value"] } },
  { id: "BROWSER_SELECT_OPTION", name: "browser_select_option", op: "select_option", description: "Select one or more options in a select element by ref.", schema: { required: ["ref", "values"] } },
  { id: "BROWSER_PRESS_KEY", name: "browser_press_key", op: "press_key", description: "Press a key in the browser page, for example Enter, Escape, Tab, ArrowDown, or a single character.", schema: { required: ["key"] }, canNavigate: true },
  { id: "BROWSER_SCROLL", name: "browser_scroll", op: "scroll", description: "Scroll the page or scroll an element into view (pass its ref)." },
  { id: "BROWSER_DRAG", name: "browser_drag", op: "drag", description: "Drag an element by ref to another ref or viewport coordinates.", schema: { required: ["sourceRef"] } },
  { id: "BROWSER_GET_BOUNDING_BOX", name: "browser_get_bounding_box", op: "get_bounding_box", description: "Get the viewport bounding box for an element ref.", schema: { required: ["ref"] }, skipScreenshot: true },
  { id: "BROWSER_HIGHLIGHT", name: "browser_highlight", op: "highlight", description: "Highlight an element by ref in the browser page for visual grounding. The returned screenshot shows the highlight.", schema: { required: ["ref"] } },
  { id: "BROWSER_CDP", name: "browser_cdp", op: "cdp", description: "Send a Chrome DevTools Protocol command to the target browser tab. Do not use CDP Input.* methods; use dedicated browser tools for clicks, text input, key presses, scrolling, and drag-and-drop. Browser-wide, storage, cookie, cache, permission, and target-management commands are denied.", schema: { required: ["method"] }, canNavigate: true },
  { id: "BROWSER_TABS", name: "browser_tabs", op: "tabs", description: "List, create, close, or select a browser tab.", schema: { required: ["action"], enum: { action: ["list", "new", "close", "select"] } }, skipScreenshot: true },
  { id: "BROWSER_TAKE_SCREENSHOT", name: "browser_take_screenshot", op: "screenshot", description: "Take a screenshot of the current page. Usually redundant: every browser action already returns one. Use fullPage for the full scrollable page." },
];

function assertArguments(
  schema: BrowserToolSchema,
  args: Record<string, unknown>,
): void {
  for (const key of schema.required ?? []) {
    if (args[key] == null || args[key] === "") {
      throw new SlateBrowserDriverError(`${key} is required`);
    }
  }
  for (const [key, values] of Object.entries(schema.enum ?? {})) {
    if (typeof args[key] !== "string" || !values.includes(args[key])) {
      throw new SlateBrowserDriverError(
        `${key} must be one of ${values.join(", ")}`,
      );
    }
  }
}

export function createSlateBrowserTools<Context>(
  ports: BrowserDriverDependencies<Context> & {
    readonly onPossibleNavigation?: (browserCtx: Context) => void;
  },
): BrowserToolDefinition<Context>[] {
  const driverClient = new SlateBrowserDriver(ports);
  return BROWSER_TOOL_NOTES.map((note) => ({
    id: note.id,
    name: note.name,
    description: note.description,
    op: note.op,
    schema: note.schema ?? {},
    ...(note.canNavigate === true ? { canNavigate: true } : {}),
    ...(note.skipScreenshot === true ? { skipScreenshot: true } : {}),
    async execute(browserCtx, args, callContext) {
      try {
        assertArguments(note.schema ?? {}, args);
        if (ports.autoReview !== undefined) {
          const exactAction = toBrowserReviewAction(note.op, args, ports.getDefaultViewId());
          await runSlateBrowserAutoReviewPreflight({
            ctx: browserCtx as unknown as OperationContext,
            resourceAccessor: ports.resourceAccessor as ResourceAccessor<RemoteExecManager>,
            options: {
              ...ports.autoReview,
              captureReviewState: (stateCtx, stateToolCallId) => captureReviewState({
                ctx: stateCtx,
                resourceAccessor: ports.resourceAccessor as ResourceAccessor<RemoteExecManager>,
                toolCallId: stateToolCallId,
                resolveDisplayNumber: ports.autoReview!.resolveDisplayNumber,
                ...(note.op !== "tabs" && exactAction.viewId === undefined ? {} : { viewId: exactAction.viewId }),
              }),
            },
            exactAction,
            toolCallId: callContext.toolCallId,
            ...(callContext.stateHandler === undefined ? {} : { stateHandler: callContext.stateHandler }),
            ...(callContext.workspacePaths === undefined ? {} : { workspacePaths: callContext.workspacePaths }),
          });
        }
        const driverOutput = await driverClient.run(browserCtx, {
          op: note.op,
          toolCallId: callContext.toolCallId,
          args,
          ...(note.skipScreenshot === undefined
            ? {}
            : { skipScreenshot: note.skipScreenshot }),
        });
        if (note.canNavigate === true && driverOutput.isError !== true) {
          ports.onPossibleNavigation?.(browserCtx);
        }
        return driverOutput;
      } catch (error) {
        return {
          text: error instanceof Error ? error.message : String(error),
          isError: true,
        };
      }
    },
    render(driverOutput) {
      if (driverOutput.imageB64 != null && driverOutput.imageB64.length > 0) {
        const key = stashScreenshot(driverOutput.imageB64);
        const image = stashedShots.get(key);
        stashedShots.delete(key);
        return {
          kind: "image",
          text: driverOutput.text,
          ...(image == null ? {} : { imageB64: image }),
          ...(driverOutput.isError === true ? { isError: true } : {}),
        };
      }
      return {
        kind: "text",
        text: driverOutput.text,
        ...(driverOutput.isError === true ? { isError: true } : {}),
      };
    },
  }));
}
