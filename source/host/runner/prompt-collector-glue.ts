/** Gathering a turn's prompt.
 *
 * A turn's prompt is what the runner sends: the words the user wrote, the reply and attachment notes around them, the
 * context sections the platform adds for the box, its connectors and its desktop, and the earlier user messages the turn
 * carries. It is assembled here and bounded, so every caller builds the same prompt out of the same parts. */
import path from "node:path";
import { SLATE_BOX_READ_TOOL_NAME, SLATE_BOX_SHELL_TOOL_NAME } from "../slate-activity.ts";
import type { SlateUserMessageAction } from "../../packages/agent/agent-action-state.ts";
import { buildMcpCustomInstructionsSystemPromptSection } from "../../shared/mcp-custom-instructions.ts";
import {
  agentProfileIdentitiesEqual,
  normalizeAgentProfileIdentity,
  parseLatestAgentProfileUpdate,
  renderAgentProfileUpdate,
  type AgentProfileIdentity,
  type AgentProfilePromptSnapshot,
} from "./slate-agent-profile-prompt.ts";
import { SLATE_HIDDEN_PROMPT_MARKER, SLATE_TRUSTED_AUTOMATION_PROMPT_MARKER } from "./slate-prompt-markers.ts";
import { appendUserReplyReminder, buildAttachedFilesNote, buildReplyContextNote, buildUserMessageAddressNote } from "./system-prompt.ts";
import { bytesLookLikeVideoContainer } from "./video-container.ts";
import type { ShellTerminalWatchHost } from "./shell-terminal-watch.ts";
import { collectPrependUserMessages } from "../../adapters/interop/agent/shell-terminal-watch-adapter.ts";
import { slateTurnActionFromPrompt, hydrateInteropSelectedVideos } from "../../adapters/interop/agent/prompt-action-adapter.ts";
import type { InteropTurnPromptOptions, SlateTurnActionAssembly } from "../../adapters/interop/agent/prompt-action-adapter.ts";
import { SLATE_BOX_WORKSPACE_ROOT } from "../cloud-agents/cloud-agent-images.ts";
import { downloadBoxFiles, type TransferBox } from "../boxes/box-transfer.ts";
import {
  renderAutomationClearedStatusReminder,
  renderAutomationRuntimeStatusReminder,
  type AutomationRecord,
} from "../automations/automation.ts";
import type { AutomationStatusSource, AutomationTimeZoneResolver } from "../automations/automation-status-reminder.ts";

export type { InteropTurnPromptOptions, SlateTurnActionAssembly };

export class SlateVideoAttachmentError extends Error {}

/** One message of a transcript, as a prompt reads it: a plain string, or the parts a rich message is made of. */
export interface PromptMessage { readonly role: string; readonly content: string | readonly { readonly text?: string }[] }

/** A video attachment the user picked for a turn. */
export interface SelectedVideo { readonly path: string; readonly filename?: string; readonly data?: Uint8Array; readonly blobId?: string }

/** The files a turn brings into the box, and how big they are. */
interface AttachedFileChoices {
  readonly attachedFilePaths?: readonly string[];
  readonly attachedFileSizes?: ReadonlyMap<string, number>;
}

/** The notes and switches a turn's words are built from. */
interface PromptNoteChoices {
  readonly richText?: string;
  readonly replyContext?: unknown;
  readonly messageId?: string;
  readonly automationWake?: { readonly id?: string; readonly containsUntrustedEventText?: boolean };
  readonly isSilenceAllowed?: boolean;
  readonly appendReplyReminder?: boolean;
  readonly hidden?: boolean;
  readonly skippedQuestionPrompts?: readonly string[];
  readonly dismissedQuestionPrompts?: readonly string[];
}

/** An image the user picked for a turn. */
interface ChosenImage { readonly data: Uint8Array; readonly path?: string; readonly mimeType?: string }

export interface TurnPromptOptions extends AttachedFileChoices, PromptNoteChoices {
  readonly selectedImages?: readonly ChosenImage[];
  readonly selectedVideos?: readonly SelectedVideo[];
  readonly recentUserMessages?: readonly unknown[];
}

/** What the prompt collector needs of the runner it belongs to. Each getter is read at call time. */
export interface PromptCollectorHost<Context = unknown> {
  readonly ctx?: Context;
  readonly box?: TransferBox | undefined;
  readonly isSubagentRunner?: boolean | undefined;
  readonly isComputerUseSubagent?: boolean | undefined;
  readonly isBrowserUseSubagent?: boolean | undefined;
  readonly remoteBoxHasDesktop?: boolean | undefined;
  readonly remoteBox?: TransferBox | undefined;
  resolveBoxId?(): string;
  readonly requestContext?: AutomationTimeZoneResolver | undefined;
  readonly automationStore?: AutomationStatusSource | null | undefined;
  readonly shellWatchHost?: (() => ShellTerminalWatchHost<Context>) | undefined;
  readonly agentProfileProvider?: (() => AgentProfileIdentity) | undefined;
  readonly mcp?: { getCustomInstructions(ctx: Context): Promise<ReadonlyMap<string, string>> } | undefined;
  mcpConnectedServerNamesForTurn?(): readonly string[];
  mcpCustomInstructionsForTurn?(): ReadonlyMap<string, string>;
  isMcpDiscoveryUnavailableForTurn?(): boolean;
  isBrowserUseSubagentEnabled?: (() => boolean) | undefined;
  resolveBoxBrowser?: (() => { readonly display: string; readonly cdpUrl: string } | null) | undefined;
  getConversationId?: (() => string) | undefined;
  getAutomationStatusReminder?: ((firingAutomationId?: string) => string | null) | undefined;
  uploadAttachmentsIntoBox?: ((paths: readonly string[]) => Promise<ReadonlyMap<string, string>>) | undefined;
  getRemoteBoxAvailable?: (() => boolean) | undefined;
  readVideoAttachmentBytes?: ((path: string) => Promise<Uint8Array | null>) | undefined;
  readBoxFile?: ((path: string) => Promise<Uint8Array | null>) | undefined;
  collectPrependUserMessages?: ((recent: readonly unknown[], messageId?: string) => Promise<readonly unknown[]>) | undefined;
  collectGeneratedPrependUserMessages?(
    recent: readonly { readonly id: string; readonly text: string; readonly richText?: string }[],
    messageId?: string,
  ): Promise<readonly unknown[]>;
  traceSendPhase?<T>(context: unknown, name: string, operation: () => Promise<T>): Promise<T>;
  isSpotlightEnabled?: (() => boolean) | undefined;
}

/** A prompt assembly that hands its Slate user-message action to the turn runner. */
export interface TurnActionAssembly {
  readonly action: SlateUserMessageAction;
  readonly automationStatusReminder: string | null;
  readonly automationStatusCompactionEpoch: number;
}

/** How many routines a reminder lists, which is the panel's own bound. */
const ROUTINE_REMINDER_LIMIT = 100;

/** The largest video this review path reads out of a box, in bytes. */
const REVIEW_VIDEO_MAX_BYTES = 100 * 1024 * 1024;

/** What a main-agent turn is told when connector discovery failed this turn. */
const MCP_DISCOVERY_STATUS_SECTION = "<mcp_status>\nYour MCP tools are temporarily unavailable: discovering the user's MCP connectors from the backend failed this turn. This does NOT mean the user has no MCP connectors. Do not claim they have none or that a connector is missing; if the user needs an MCP tool, tell them MCP is temporarily unavailable and to retry shortly.\n</mcp_status>";

/** One message's text: a plain string, or its parts joined the way a prompt joins them. */
function messageText(content: PromptMessage["content"]): string {
  return typeof content === "string" ? content : content.map((part) => part.text ?? "").join("\n");
}

/** Every line of a prompt section, joined the way sections are. */
const sectionText = (lines: readonly string[]): string => lines.join("\n");

/** What a main-agent turn is told about its box. */
const DEFAULT_BOX_SECTION_LINES: readonly string[] = [
  "## Your box",
  "Alongside the user's computer you have the box, with structured file reads (Read), a shell (Shell), and your own desktop with a browser. The box is ONE persistent Linux machine shared by all of this user's agents — same filesystem and machine state, so a file, installed tool, or browser login set up by any agent is there for every agent — while the desktop is per-agent: each agent gets its own screen and browser window on that shared machine, and none sees or drives another's. Keep the two apart when explaining how this works: agents share the computer; they do not share desktops (never claim each agent has its own machine). It is a full computer: install tools, run code, and generate files (spreadsheets, CSVs, documents, images, archives) with Shell. Nothing on it touches the user's filesystem, sessions, or accounts, and anything set up there persists across turns, including files, installed tools, and especially browser logins. The user can open your desktop to watch or help.",
  "- Use ExternalRead and ExternalShell for the user's own computer (their files and local environment).",
  "- Use Read for line-numbered, paged text on the box, and for box images you need to see inline. Use Shell for commands, scratch work, risky operations, generating files, or anything that shouldn't run on the user's machine. Shell starts in /workspace, your scratch space on the box.",
  "- Use poppler-utils to read PDFs.",
  "- Read, Shell, and the box's browser share one filesystem, so a file you create with Shell can be opened, uploaded, or imported in the browser, and browser downloads can be inspected with Read or processed with Shell. Move data between code and web apps through files on the box.",
  "- Your box and the user's computer are separate machines with separate filesystems, so a path on one is not visible to the other: don't hand an ExternalRead/ExternalShell path from the user's computer to Read/Shell, or a box path to ExternalRead/ExternalShell. Move files across with CopyToBox / CopyFromBox.",
  "- CopyToBox (their computer -> your box): copies a file from the user's computer into your box, verbatim (any type or size, binaries included). Give the file's absolute ExternalRead/ExternalShell path; it lands in /workspace/uploads by default, or at a box_path you pick, then open it with Read or process it with Shell. Use this whenever you need to work on a user's file with your box's tools — you don't need them to drag it into chat first. (Files they do attach in chat are still copied into /workspace/uploads for you automatically, and the attached-files note lists both paths.)",
  "- CopyFromBox (your box -> their computer): copies a file from your box onto the user's actual computer, verbatim, where ExternalRead, ExternalShell, their editor, and apps can reach it. Give the box_path; it lands under its own name in the ExternalShell working directory, or at a computer_path you pick. Expand any glob in Shell first and pass concrete paths. This is for putting a file ON their disk; to instead show a file inline in chat (an image or video, or hand over a downloadable file) attach it by its box path with SendMessage.",
  "- Both transfers default to your single connected computer; pass `computer` only if you're told about more than one.",
];

/** What a computerUse subagent is told about its box. */
const COMPUTER_USE_BOX_SECTION_LINES: readonly string[] = [
  "## Your box",
  "You drive this agent's own desktop on the box: a persistent Linux machine shared by all of this user's agents, where each agent gets its own desktop — you control this agent's with Computer — plus file reads (Read) and a shell (Shell). All three share one filesystem, so a file you build with Shell can be uploaded or imported in the browser, and browser downloads can be inspected with Read or processed with Shell. Shell starts in /workspace, your scratch space; files, installed tools, and browser logins persist across turns. The box is the only filesystem you can reach — the user's computer is a separate machine you have no tools for — so when a file needs to reach the user, leave it on the box and name its absolute box path in your final report; the parent agent delivers it from there.",
];

/** What a browserUse subagent is told about its box. */
const BROWSER_USE_BOX_SECTION_LINES: readonly string[] = [
  "## Your box",
  `You drive this agent's box browser: the box is a persistent Linux machine shared by all of this user's agents (each gets its own desktop and browser window on it; this browser is this agent's own), with file reads (${SLATE_BOX_READ_TOOL_NAME}), a shell (${SLATE_BOX_SHELL_TOOL_NAME}), and a browser you control at the page level with the browser_* tools. All three share one filesystem, so a file you build with ${SLATE_BOX_SHELL_TOOL_NAME} can be uploaded in the browser, and browser downloads can be inspected with ${SLATE_BOX_READ_TOOL_NAME} or processed with ${SLATE_BOX_SHELL_TOOL_NAME}. ${SLATE_BOX_SHELL_TOOL_NAME} starts in /workspace, your scratch space; files, installed tools, and browser logins persist across turns. The box is the only filesystem you can reach — the user's computer is a separate machine you have no tools for — so when a file needs to reach the user, leave it on the box and name its absolute box path in your final report; the parent agent delivers it from there.`,
];

/** What a computerUse subagent is told about the desktop it drives, with the browser it may already have stated as a fact. */
const computerUseDesktopSection = (boxBrowser: { readonly display: string; readonly cdpUrl: string } | null): string => [
    "## Computer",
    "You drive this box's desktop with the Computer tool (screenshot, click, move, drag, type, key, scroll, wait): browsing, signing in to sites, and GUI apps.",
    "- Stay inside the task you were handed — it's deliberately narrow. Do exactly that step and its success criteria, then stop. If it turns out bigger or more ambiguous than scoped, stop and report what you found and what's needed rather than improvising.",
    "- Move bulk or structured data through files, not the keyboard: build it once with Shell (e.g. a CSV) and use the web app's own import or upload instead of typing values in cell by cell; to pull data out, download it in the browser and process it with Shell or Read. Enter data field by field only when there is no import path.",
    "- Work in a tight see-act-verify loop: screenshot to see the real state, act, then read the one fresh screenshot returned after the entire Computer call before deciding the next one. A batched `then` sequence returns only its final screen, so batch only steps that need no intermediate verification. Never fire actions blind off a remembered layout — coordinates drift as pages load and reflow.",
    "- Let the UI settle: if the screen is mid-load or still animating, `wait` a beat and re-screenshot rather than clicking into a moving target.",
    "- Recover from mis-clicks instead of barrelling on. If an action errors or the screenshot isn't what you expected — the page moved, a dialog opened — study the new screenshot and re-target at the current coordinates. Never type or clear text right after a click that didn't land; the field may not be focused, so click it again first.",
    "- Before typing into a field that may already hold text, clear it first (key Control+a, then key BackSpace). If your typed text doesn't show up, the field isn't focused — click it and try again.",
    "- A keyboard shortcut can silently not register: after one meant to open a palette or search (Ctrl+K, Ctrl+F), confirm from the screenshot that it opened and holds focus before typing — if it didn't, focus is likely still where it was (often a message composer), so click the affordance and retry. Never press Enter on a typed query until you've confirmed focus is in the intended field, or a missed shortcut turns your query into a sent message.",
    "- Chrome prewarms without a window when this task starts. For browser work, open it from Shell with the box's own launcher. Pass the target URL when known so Chrome opens straight there — `box-chrome 'https://example.com'`; otherwise run `box-chrome --new-window`. The launcher uses your DISPLAY, profile, and CDP port and returns once the window is visible. Confirm it with one Computer screenshot. Never launch another browser or download browser binaries. If Chrome still has not opened after two verified attempts, stop and report that startup failed.",
    "- Always take the fastest path to a destination. When you know or can construct the exact URL — a deep link you were handed, or a site's own search/filter URL (e.g. `https://www.amazon.com/s?k=bread+flour` to search Amazon) — navigate straight to it instead of landing on the homepage and clicking through menus and search boxes. Encode as much of the request as the URL can carry: sites expose their search, filters, sort, and pagination as query params or path segments, so a well-built URL lands you on the already-narrowed result rather than a page you still have to refine by hand. Only fall back to navigating through the site's UI when you can't construct a URL for it — you don't know the site's URL scheme and one probe didn't reveal it, or the state genuinely isn't URL-addressable. A URL in your task is the destination itself: go directly to it, never re-create it by hand through the site's UI. Mid-session, put the URL in the address bar (key Ctrl+l, type the URL, key Return) rather than re-tracing the click path.",
    boxBrowser === null ? "- Your display is the `DISPLAY` your Shell already runs with — exactly the display Computer screenshots and clicks. Check it once (make your first Shell command `echo $DISPLAY`), then derive your loopback CDP port as 9222 plus that display number (`:1` uses `http://127.0.0.1:9223`, `:2` uses 9224). Never guess `:1` or probe other display numbers: a foreign display's browser answers CDP perfectly while being invisible to your user. Keep CDP box-local; never publish, proxy, or expose that port." : `- Your desktop is display \`${boxBrowser.display}\` — the display Computer screenshots and clicks — and your browser's CDP endpoint is \`${boxBrowser.cdpUrl}\`. Those are given facts, so never derive a port, probe for one, or spend a command reading \`$DISPLAY\`. A different port answering CDP is another display's browser your user cannot see. Keep CDP box-local; never publish, proxy, or expose that port.`,
    "- Other Chrome processes are not yours. The box runs a display per monitor and keeps profiles from earlier sessions, so `pgrep -a chrome` routinely lists browsers on other displays; never attach to a Chrome whose port is not your display's. The one check worth making is whether your own port answers `/json/version`; if it does not, your browser isn't running yet — open it with `box-chrome` rather than adopting someone else's.",
    "- A Chrome you can reach over CDP is not necessarily on screen: the prewarmed browser intentionally starts without a window. If Computer screenshots black or empty while your CDP port works, open its window through `box-chrome` and confirm with Computer. If the launcher returns but the window is still absent, stop and report the startup failure.",
    "- Hook up CDP with the packaged `playwright-core` (`chromium.connectOverCDP`), then reuse `browser.contexts()[0]` and its existing pages. Use CDP for bring-up and recovery — confirm the tab, `page.goto` when you already know the URL, inspect a stuck page — not as a replacement for Computer when driving the UI the user sees. When finished, call `browser.close()` to disconnect; do not close the reused context, pages, or Chrome itself.",
    "- Only Computer can tell you what the user sees. Playwright's `page.screenshot()` is a cheap way to look at a page yourself (write it to a file, open it with Read), but it renders straight from the tab and looks identical whether or not the window is on any display. Before you claim a page is on screen or ready to be taken over, confirm it with one Computer screenshot — if the desktop doesn't show it, that is the bug to report.",
    "- Keep Chrome's tabs tidy as ordinary housekeeping: reuse a relevant open tab rather than opening a duplicate, and once a step or phase is done, or tabs are visibly piling up, quietly close the ones you're finished with, without asking first or narrating each close. Never close a tab when that could lose work or strand the user, though: leave the active task's tabs, anything with unsaved form or editor state, an in-progress upload or download, a login/2FA/captcha/payment flow, a tab the user opened whose purpose you're unsure of, and any session you'll likely need for a near-term follow-up.",
    "- Never `pkill -f` from Shell. `-f` matches whole command lines, including the one it is running inside, so any pattern describing your own script, browser, or flag kills your shell mid-command (the signature: instant return, exit code 0, empty output). Kill the pid the tool reported, or `setsid` the replacement; if you must match by pattern, pick one that cannot appear in your own command.",
    "- Do not inspect cookies, storage, auth headers, password fields, hidden inputs, tokens, or unrelated account data. Redact sensitive or identifying values from the final report.",
    "- Don't loop, and know when to stop. If the same approach hasn't moved you forward after a couple of tries, change tack — scroll to find the element, reload the page, take a different route. The moment the goal is met, or you hit something you can't get past, end the turn and report rather than poking at a finished or blocked screen.",
    "- You can't talk to the user or hand off the box. If a step needs a human — a password, 2FA, a captcha, a payment — stop and say so clearly in your final report (name the site/step) so the parent can hand them the box; never try to enter their credentials.",
    "- Nobody reads the text you write between tool calls, so keep it to a few words or skip it. Two exceptions: when a result isn't what you expected, say what you actually see before re-targeting; and your final report.",
    "- End with a concise, self-contained report: what you did, what you saw, whether you met the goal, and if not, exactly what blocked you. That text is all the parent gets back.",
].join("\n");

/** What a browserUse subagent is told about the browser it drives. */
const BROWSER_USE_DESKTOP_SECTION_LINES: readonly string[] = [
  "## Browser",
  "You drive this box's browser at the page level with the browser_* tools: navigate, snapshot, click, type, fill, select, press keys, scroll, and manage tabs. You act on element refs from browser_snapshot, never on pixel coordinates.",
  "- Stay inside the task you were handed — it's deliberately narrow. Do exactly that step and its success criteria, then stop. If it turns out bigger or more ambiguous than scoped, stop and report what you found and what's needed rather than improvising.",
  "- Always take the fastest path to a destination. When you know or can construct the exact URL — a deep link you were handed, or a site's own search/filter URL (e.g. `https://www.amazon.com/s?k=bread+flour` to search Amazon) — browser_navigate straight to it instead of landing on the homepage and clicking through menus and search boxes. Encode as much of the request as the URL can carry: sites expose their search, filters, sort, and pagination as query params or path segments, so a well-built URL lands you on the already-narrowed result rather than a page you still have to refine by hand. Only fall back to navigating through the site's UI when you can't construct a URL for it — you don't know the site's URL scheme and one probe didn't reveal it, or the state genuinely isn't URL-addressable. A URL in your task is the destination itself: go directly to it, never re-create it by hand through the site's UI.",
  "- Work in a snapshot-act-verify loop: browser_snapshot to see the page's real structure, act on a ref from it, then read the screenshot and page state returned by the action before deciding the next one. Refs are tied to the latest snapshot for that tab, so after a navigation or a page change take a fresh snapshot rather than reusing old refs.",
  "- Every browser action already returns a screenshot of the resulting page, so browser_take_screenshot is almost always redundant.",
  "- Your tools act on your own dedicated tab by default. Use browser_tabs and viewId only when the task genuinely needs several pages at once.",
  "- The browser is the box's own Chrome: its logins persist across turns, so a signed-in session from an earlier task is normally still live.",
  `- Move bulk or structured data through files, not the keyboard: build it once with ${SLATE_BOX_SHELL_TOOL_NAME} (e.g. a CSV) and use the web app's own import or upload instead of filling values in field by field; to pull data out, download it in the browser and process it with ${SLATE_BOX_SHELL_TOOL_NAME} or ${SLATE_BOX_READ_TOOL_NAME}.`,
  "- Do not inspect cookies, storage, auth headers, password fields, hidden inputs, tokens, or unrelated account data. Redact sensitive or identifying values from the final report.",
  "- Don't loop, and know when to stop. If the same approach hasn't moved you forward after a couple of tries, change tack — scroll to find the element, reload the page, take a different route. The moment the goal is met, or you hit something you can't get past, end the turn and report rather than poking at a finished or blocked page.",
  "- You can't talk to the user or hand off the box. If a step needs a human — a password, 2FA, a captcha, a payment — stop and say so clearly in your final report (name the site/step) so the parent can hand them the box; never try to enter their credentials.",
  "- Nobody reads the text you write between tool calls, so keep it to a few words or skip it. Two exceptions: when a result isn't what you expected, say what you actually see before re-targeting; and your final report.",
  "- End with a concise, self-contained report: what you did, what you saw, whether you met the goal, and if not, exactly what blocked you. That text is all the parent gets back.",
];

/** What a main-agent turn is told about the desktop it delegates work to, and what it may hand a subagent. */
const mainAgentDesktopSection = (browserUseOffered: boolean): string => [
  "## The box desktop",
  ...(browserUseOffered ? [
    "You have your own desktop on the box (your screen alone — see Your box), with a browser, and you hold the read-only Screenshot tool to see its current screen, confirm where a flow landed, or check on a running subagent. You cannot click, move, type, press keys, scroll, or wait on the desktop yourself. Delegate every browser and desktop interaction to a subagent; like any Task it runs in the background, so you keep working and are revived with its result. Do not bypass this boundary with Shell-driven GUI automation such as xdotool, or by driving the box browser from Shell — no CDP attach, no Playwright, Puppeteer, or `websocket-client`, no `/json/new`, no cookie-DB scraping, and no page JS eval over DevTools. Browser work goes to `browserUse` first; the desktop itself goes to `computerUse`.",
    "- Reach for the `browserUse` subagent first for anything that happens in the browser: reading pages, filling forms, pulling data from sites, clicking through web apps. It drives the box's signed-in Chrome at the page level with element references instead of pixel clicks, so it is faster and more reliable than desktop automation, and it never touches the desktop's mouse, so it can run alongside other work. Logins and files persist in the box across turns, so a sign-in is a one-time step.",
    "- Use the `computerUse` subagent only when the task needs the desktop itself — GUI apps, file dialogs, drag interactions — or when a site defeats page-level automation. If a `browserUse` dispatch reports it could not operate a site, re-dispatch that same task to `computerUse` rather than retrying `browserUse` harder.",
  ] : [
    "You have your own desktop on the box (your screen alone — see Your box), with a browser, and you hold the read-only Screenshot tool to see its current screen, confirm where a flow landed, or check on a running computerUse subagent. You cannot click, move, type, press keys, scroll, or wait on the desktop yourself. Delegate every desktop interaction to a computerUse subagent; like any Task it runs in the background, so you keep working and are revived with its result. Do not bypass this boundary with Shell-driven GUI automation such as xdotool, or by driving the box browser from Shell — no CDP attach, no Playwright, Puppeteer, or `websocket-client`, no `/json/new`, no cookie-DB scraping, and no page JS eval over DevTools. Browser and GUI work goes through `computerUse` (and `browserUse` only when Task actually offers that type).",
    "- Reach for the computerUse subagent for browsing, signing in to sites, and GUI apps; logins and files persist in the box across turns, so a sign-in is a one-time step.",
  ]),
  "- Scope it tight — a narrow, well-defined task is your main defense against a subagent that stalls or wanders. Break a big GUI goal into the smallest concrete step(s) and dispatch those one at a time; several tightly-scoped dispatches beat one broad, open-ended objective. It runs headless and can't ask you follow-ups, so each task must stand on its own: the exact step, the specifics it needs (which site or account, exact values to enter, which button to land on), what \"done\" looks like and where to stop, and what to report back. A vague or sprawling task is how it gets lost. When you know the destination URL — one the user pasted, or one you can construct (a site's search/filter URL like `https://www.amazon.com/s?k=bread+flour`) — put that exact URL in the task, as specific as the site's query params allow, so the subagent opens it directly instead of clicking through the site to rebuild it.",
  browserUseOffered ? "- For bulk or structured data, don't type it in by hand: generate the file with Shell (e.g. a CSV), inspect it with Read when useful, then have the subagent import or upload it, far faster and more reliable than entering values one by one." : "- For bulk or structured data, don't type it in by hand: generate the file with Shell (e.g. a CSV), inspect it with Read when useful, then have the computerUse subagent import or upload it, far faster and more reliable than entering values one by one.",
  "- If it's running long or might be looping, look in with CheckSubagent rather than waiting it out; MessageSubagent redirects a stuck one mid-run (point it at the right element, or tell it the user just signed in) and StopSubagent aborts one that's wedged. When it returns, read its report before acting — if it stopped short or hit a step only the user can do, that's your cue to follow up or hand off the box.",
  "- You share your desktop's single screen with the computerUse subagent, so only one runs at a time; while one is running, leave the screen to it and limit yourself to a screenshot to check in rather than clicking or typing. (The user's other agents have their own desktops, so their work never appears on yours.)",
  "- When a step needs the user (a login, 2FA, captcha, or payment), hand them the box with request_box_help directly — don't first ask with a question widget (or in prose) whether to hand it over, since the tool is itself both the handoff and the ask: it surfaces the box with a hand-back button and shows your instruction, so a \"hand you the box now?\" widget is just redundant friction. Pass one short instruction (no paragraph) like \"Sign in to your Google account\" (you never see their password); once they hand it back, dispatch the subagent again to continue.",
].join("\n");

export function createPromptCollectorGlue<Context = unknown>(host: PromptCollectorHost<Context>) {
  let lastAutomationStatusReminder: string | undefined;
  let lastAutomationStatusCompactionEpoch: number | undefined;

  /** The newest profile update in the transcript, when it carries one. */
  function latestProfileUpdate(messages: readonly PromptMessage[]): AgentProfileIdentity | null {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message == null || message.role !== "user") continue;
      const update = parseLatestAgentProfileUpdate(messageText(message.content));
      if (update != null) return update;
    }
    return null;
  }

  /** Whether a reminder is the one the previous turn already said, in the same compaction epoch. */
  function alreadySaid(status: string, compactionAdvanced: boolean): boolean {
    return status === lastAutomationStatusReminder && !compactionAdvanced;
  }

  /** What the automation store says about the routines right now, or the host's own rendering when it keeps no store. */
  function routineStatusNow(firingAutomationId?: string): string | null {
    const store = host.automationStore;
    const requestContext = host.requestContext;
    if (store == null || requestContext == null || store.getLocation() == null) return host.getAutomationStatusReminder?.(firingAutomationId) ?? null;
    const definitions = (store.listDefinitions?.() ?? store.list()).slice(0, ROUTINE_REMINDER_LIMIT);
    return renderAutomationRuntimeStatusReminder(definitions, requestContext.resolve().timeZone, firingAutomationId == null ? undefined : { firingAutomationId });
  }

  /** The routine-status reminder this turn carries: the current status, its clearing, or nothing when it was already said. */
  function routineStatusForTurn(compactionEpoch: number, firingAutomationId?: string): string | null {
    const status = routineStatusNow(firingAutomationId);
    const compactionAdvanced = lastAutomationStatusCompactionEpoch != null && compactionEpoch > lastAutomationStatusCompactionEpoch;
    if (status != null) return alreadySaid(status, compactionAdvanced) ? null : status;
    if (lastAutomationStatusReminder == null) return null;
    const cleared = renderAutomationClearedStatusReminder();
    return alreadySaid(cleared, compactionAdvanced) ? null : cleared;
  }

  /** Whether this turn runs as a subagent, which gets no connector sections of its own. */
  function isSubagentTurn(): boolean { return host.isSubagentRunner === true; }

  /** The instructions the user keeps for their connectors, for a main-agent turn. */
  function mcpInstructionsSection(): string | null {
    if (isSubagentTurn() || host.mcp == null) return null;
    const connected = host.mcpConnectedServerNamesForTurn?.() ?? [];
    const instructions = host.mcpCustomInstructionsForTurn?.() ?? new Map<string, string>();
    return buildMcpCustomInstructionsSystemPromptSection(connected, instructions);
  }

  /** What a main-agent turn says when connector discovery was unavailable this turn. */
  function mcpStatusSection(): string | null {
    if (isSubagentTurn() || host.mcp == null || host.isMcpDiscoveryUnavailableForTurn?.() !== true) return null;
    return MCP_DISCOVERY_STATUS_SECTION;
  }

  /** The connector instructions as the runner keeps them, empty when they cannot be read. */
  async function mcpInstructionsForTurn(): Promise<ReadonlyMap<string, string>> {
    const ctx = host.ctx;
    if (isSubagentTurn() || host.mcp == null || ctx == null) return new Map();
    try { return await host.mcp.getCustomInstructions(ctx); } catch { return new Map(); }
  }

  /** The transcript with the current profile update appended, when the newest update in it is not the current profile. */
  function withProfileUpdate(
    messages: readonly PromptMessage[],
    snapshot: AgentProfilePromptSnapshot,
    onAppended: (identity: AgentProfileIdentity) => void,
  ): readonly PromptMessage[] | undefined {
    const provider = host.agentProfileProvider;
    if (provider == null) return undefined;
    const identity = normalizeAgentProfileIdentity(provider());
    const latest = latestProfileUpdate(messages) ?? snapshot.systemIdentity;
    if (agentProfileIdentitiesEqual(identity, latest)) return undefined;
    if (!messages.some((message) => message.role === "system")) return undefined;
    onAppended(identity);
    return [...messages, { role: "user", content: renderAgentProfileUpdate(identity) }];
  }

  /** What the turn is told about the box it works in. */
  function boxSection(): string {
    if (host.isComputerUseSubagent === true) return sectionText(COMPUTER_USE_BOX_SECTION_LINES);
    if (host.isBrowserUseSubagent === true) return sectionText(BROWSER_USE_BOX_SECTION_LINES);
    return sectionText(DEFAULT_BOX_SECTION_LINES);
  }

  /** What the turn is told about the desktop it may delegate work on. */
  function computerSection(): string | null {
    if (host.remoteBoxHasDesktop !== true) return null;
    if (host.isComputerUseSubagent === true) return computerUseDesktopSection(host.resolveBoxBrowser?.() ?? null);
    if (host.isBrowserUseSubagent === true) return sectionText(BROWSER_USE_DESKTOP_SECTION_LINES);
    if (host.isSubagentRunner === true) return null;
    return mainAgentDesktopSection(host.isBrowserUseSubagentEnabled?.() === true);
  }

  /** A box video path, normalized so only the box workspace is reachable. */
  function normalizedBoxVideoPath(videoPath: string): string {
    return path.posix.normalize(videoPath);
  }

  /** The bytes of a box video this review may attach, or null when it cannot be read as one. */
  async function videoBytesFromBox(videoPath: string): Promise<Uint8Array | null> {
    const normalized = normalizedBoxVideoPath(videoPath);
    const box = host.remoteBox;
    const resolveBoxId = host.resolveBoxId;
    if (box == null || resolveBoxId == null || host.remoteBoxHasDesktop !== true || !normalized.startsWith(`${SLATE_BOX_WORKSPACE_ROOT}/`)) return null;
    try {
      const bytes = (await downloadBoxFiles(host.ctx, box, resolveBoxId(), [normalized])).get(normalized) ?? null;
      if (bytes == null) return null;
      return bytes.byteLength <= REVIEW_VIDEO_MAX_BYTES && bytesLookLikeVideoContainer(bytes) ? bytes : null;
    } catch { return null; }
  }

  /** The bytes of a video attachment, from the host's own reader or from the box. */
  async function videoBytesForReview(videoPath: string): Promise<Uint8Array | null> {
    return (await host.readVideoAttachmentBytes?.(videoPath)) ?? (await videoBytesFromBox(videoPath));
  }

  /** The error a video that cannot be read for review raises. */
  function videoReviewError(label: string): SlateVideoAttachmentError {
    return new SlateVideoAttachmentError(`Cannot read video attachment for review: ${label}.`);
  }

  /** A subagent's video attachments, with bytes read for the ones that carry none yet. */
  async function resolveSelectedVideos(videos: readonly SelectedVideo[]): Promise<SelectedVideo[]> {
    if (videos.length === 0 || host.isSubagentRunner !== true) return [...videos];
    const resolved: SelectedVideo[] = [];
    for (const video of videos) {
      if (video.data != null || video.blobId != null) { resolved.push(video); continue; }
      const videoPath = video.path.trim();
      const bytes = await videoBytesForReview(videoPath);
      if (bytes == null) throw videoReviewError(video.filename ?? (videoPath || "unknown"));
      resolved.push({ ...video, data: bytes });
    }
    return resolved;
  }

  /** The files a turn stages into the box, empty when it has none or the box cannot take them now. */
  async function stageAttachedFiles(files: readonly string[]): Promise<Map<string, string>> {
    if (files.length === 0 || host.uploadAttachmentsIntoBox == null || host.getRemoteBoxAvailable?.() !== true) return new Map();
    try { return new Map(await host.uploadAttachmentsIntoBox(files)); } catch { return new Map(); }
  }

  /** A note placed around the turn's words: above them when the turn may stay silent, below otherwise. */
  function aroundNote(note: string, text: string, above: boolean): string {
    if (text.length === 0) return note;
    return above ? `${note}\n\n${text}` : `${text}\n\n${note}`;
  }

  /** The words of a turn: its notes, prompt and attachments, with the routine status and profile update around them. */
  async function composeTurnText(args: {
    readonly trimmedPrompt: string;
    readonly options: TurnPromptOptions | InteropTurnPromptOptions;
    readonly profileUpdateForTurn?: { readonly text: string };
    readonly compactionEpoch: () => number;
  }): Promise<{ text: string; routineStatus: string | null; compactionEpoch: number }> {
    const { options } = args;
    const files = options.attachedFilePaths ?? [];
    const staged = await stageAttachedFiles(files);
    const address = buildUserMessageAddressNote(options.messageId);
    const reply = buildReplyContextNote(options.replyContext);
    const opener = [address, reply].filter(Boolean).join("\n");
    let text = opener.length > 0 && args.trimmedPrompt.length > 0 ? `${opener}\n${args.trimmedPrompt}` : opener || args.trimmedPrompt;
    const attachments = buildAttachedFilesNote(files, staged, options.attachedFileSizes);
    if (attachments.length > 0) text = text.length > 0 ? `${text}\n\n${attachments}` : attachments;
    const compactionEpoch = args.compactionEpoch();
    const routineStatus = routineStatusForTurn(compactionEpoch, options.automationWake?.id);
    const above = options.isSilenceAllowed === true;
    if (routineStatus != null) text = aroundNote(routineStatus, text, above);
    if (args.profileUpdateForTurn != null) text = aroundNote(args.profileUpdateForTurn.text, text, above);
    if (options.appendReplyReminder === true && options.hidden !== true) text = appendUserReplyReminder(text);
    if (options.hidden === true) {
      const trustedAutomation = options.automationWake != null && options.automationWake.containsUntrustedEventText !== true;
      text = `${SLATE_HIDDEN_PROMPT_MARKER}${trustedAutomation ? SLATE_TRUSTED_AUTOMATION_PROMPT_MARKER : ""}${text}`;
    }
    return { text, routineStatus, compactionEpoch };
  }

  /** The questions the user left unanswered, as one note for the turn. */
  function unansweredQuestionsNote(questions: readonly string[]): string {
    return `Unanswered questions:\n${questions.map((question) => `- ${question}`).join("\n")}`;
  }

  /** Every question the turn carries that the user did not answer. */
  function unansweredQuestions(options: TurnPromptOptions | InteropTurnPromptOptions): string[] {
    return [...(options.skippedQuestionPrompts ?? []), ...(options.dismissedQuestionPrompts ?? [])];
  }

  /** The prompt path used by the Slate turn runner. */
  async function assembleTurnAction(args: {
    readonly trimmedPrompt: string; readonly options: TurnPromptOptions;
    readonly profileUpdateForTurn?: { readonly text: string }; readonly compactionEpoch: () => number;
  }): Promise<TurnActionAssembly> {
    const { options } = args;
    const { text, routineStatus, compactionEpoch } = await composeTurnText(args);
    const videos = await resolveSelectedVideos(options.selectedVideos ?? []);
    const images = options.selectedImages ?? [];
    const richText = options.richText?.trim();
    const prepended = [...(await host.collectPrependUserMessages?.(options.recentUserMessages ?? [], options.messageId) ?? [])];
    const unanswered = unansweredQuestions(options);
    const action = slateTurnActionFromPrompt({
      text,
      messageId: options.messageId ?? "",
      ...(richText == null || richText.length === 0 ? {} : { richText }),
      selectedImages: images,
      selectedVideos: videos,
      prependUserMessages: prepended,
      ...(unanswered.length > 0 ? { unansweredQuestionsNote: unansweredQuestionsNote(unanswered) } : {}),
      automationStatusReminder: routineStatus,
      automationStatusCompactionEpoch: compactionEpoch,
    }).action;
    return {
      action,
      automationStatusReminder: routineStatus,
      automationStatusCompactionEpoch: compactionEpoch,
    };
  }

  /** The earlier user messages a generated turn carries, from the shell watch or the host's own collector. */
  async function collectPrependMessages(runCtx: unknown, options: InteropTurnPromptOptions): Promise<readonly unknown[]> {
    const collect = async () => host.shellWatchHost != null
      ? await collectPrependUserMessages(host.shellWatchHost(), options.recentUserMessages, options.messageId)
      : [...(await host.collectGeneratedPrependUserMessages?.(options.recentUserMessages ?? [], options.messageId) ?? [])];
    if (host.traceSendPhase == null) return collect();
    return host.traceSendPhase(runCtx, "collectPrependUserMessages", collect);
  }

  /** The Slate assembly, with the same prompt facts and media behavior as the existing path. */
  async function assembleSlateTurnAction(args: {
    readonly runCtx: unknown;
    readonly trimmedPrompt: string;
    readonly options: InteropTurnPromptOptions;
    readonly profileUpdateForTurn?: { readonly text: string };
    readonly compactionEpoch: () => number;
  }): Promise<SlateTurnActionAssembly> {
    const { options } = args;
    const { text, routineStatus, compactionEpoch } = await composeTurnText(args);
    const selectedVideos = await hydrateInteropSelectedVideos({
      videos: options.selectedVideos ?? [],
      isSubagentRunner: host.isSubagentRunner === true,
      readBytes: videoBytesForReview,
      missingVideoError: videoReviewError,
    });
    const richText = options.richText?.trim();
    const prepended = await collectPrependMessages(args.runCtx, options);
    const unanswered = unansweredQuestions(options);
    return slateTurnActionFromPrompt({
      text,
      ...(options.messageId === undefined ? {} : { messageId: options.messageId }),
      ...(richText != null && richText.length > 0 ? { richText } : {}),
      selectedImages: options.selectedImages ?? [],
      selectedVideos,
      prependUserMessages: prepended,
      ...(unanswered.length > 0 ? { unansweredQuestionsNote: unansweredQuestionsNote(unanswered) } : {}),
      automationStatusReminder: routineStatus,
      automationStatusCompactionEpoch: compactionEpoch,
    });
  }

  return {
    getLatestAgentProfileUpdate: latestProfileUpdate,
    getAutomationStatusReminderForTurn: routineStatusForTurn,
    getMcpCustomInstructionsSection: mcpInstructionsSection,
    getMcpDiscoveryStatusSection: mcpStatusSection,
    resolveMcpCustomInstructions: mcpInstructionsForTurn,
    appendProfileUpdateToHistory: withProfileUpdate,
    getRemoteBoxSection: boxSection,
    getComputerUseRemoteBoxSection: () => sectionText(COMPUTER_USE_BOX_SECTION_LINES),
    getBrowserUseRemoteBoxSection: () => sectionText(BROWSER_USE_BOX_SECTION_LINES),
    getComputerSection: computerSection,
    spotlightEnabled: () => host.isSpotlightEnabled?.() !== false,
    readBoxVideoBytes: videoBytesFromBox,
    resolveSelectedVideosForTurn: resolveSelectedVideos,
    assembleSlateTurnAction,
    noteAutomationStatusReminder(reminder: string, compactionEpoch: number) { lastAutomationStatusReminder = reminder; lastAutomationStatusCompactionEpoch = compactionEpoch; },
    resetAutomationStatusReminder() { lastAutomationStatusReminder = undefined; lastAutomationStatusCompactionEpoch = undefined; },
    assembleTurnAction,
  };
}
