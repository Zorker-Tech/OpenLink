/** Build bounded, privacy-aware text for Slate review cards. */
import { redactSlateAutoReviewInlineSecrets as redactReviewText } from "../../shared/slate-auto-review-redact.ts";

const SECRET_FIELD = /(?:authorization|api.?key|credential|password|secret|token)/i;
const SECRET_LITERAL = /^(?:bearer\s+)?[A-Za-z0-9_+\/-]{24,}={0,2}$/i;
const SAFE_DESTINATION_FIELDS = new Set([
  "channel", "channel_id", "channelid", "path", "page", "page_id", "pageid",
  "repo", "repository", "title", "name", "url",
]);

function redactInlineSecret(value: string): string {
  return redactReviewText(value);
}

export function compact(value: string, maxChars: number): string {
  const line = value.replace(/\s+/g, " ").trim();
  if (line.length <= maxChars) return line;
  return `${line.slice(0, maxChars - 1)}…`;
}

export function compactHeadAndTail(value: string, maxChars: number): string {
  const line = value.replace(/\s+/g, " ").trim();
  if (line.length <= maxChars) return line;

  let hiddenCount = line.length - maxChars;
  let visibleCount = 2;
  let marker = "";
  for (let pass = 0; pass < 4; pass += 1) {
    marker = `…[${hiddenCount} chars skipped]…`;
    visibleCount = Math.max(2, maxChars - marker.length);
    const measuredHidden = line.length - visibleCount;
    if (measuredHidden === hiddenCount) break;
    hiddenCount = measuredHidden;
  }
  const prefixCount = Math.ceil(visibleCount / 2);
  const suffixCount = Math.floor(visibleCount / 2);
  return `${line.slice(0, prefixCount)}${marker}${line.slice(-suffixCount)}`;
}

export function shellLocationPhrase(surface: string): string {
  return surface === "host_shell" ? "on this computer" : "in Slate's hosted workspace";
}

export function genericSlateShellAutoReviewSummary(surface: string): string {
  return surface === "host_shell"
    ? "Start a shell command on this computer"
    : "Start a shell command in Slate's hosted workspace";
}

export function describeSlateShellAutoReviewAction(args: {
  readonly surface: string;
  readonly description?: string;
  readonly workingDirectory?: string;
}): string {
  const place = shellLocationPhrase(args.surface);
  const intent = args.description?.replace(/\s+/g, " ").trim();
  const folder = args.workingDirectory === undefined ? "" : ` from ${compact(args.workingDirectory, 100)}`;
  if (intent !== undefined && intent.length > 0) {
    return compact(`${intent.replace(/[.!?]+$/u, "")} ${place}${folder}`, 340);
  }
  return compact(`${genericSlateShellAutoReviewSummary(args.surface)}${folder}`, 340);
}

export function redactMcpValue(value: unknown, key?: string, depth = 0): unknown {
  return projectSafeValue(value, key, depth);
}

function projectSafeValue(value: unknown, key: string | undefined, depth: number): unknown {
  if (key !== undefined && SECRET_FIELD.test(key)) return "…";
  if (typeof value === "string") return projectSafeText(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= 3) return Array.isArray(value) ? `[${value.length} items]` : "{…}";
  return Array.isArray(value)
    ? projectSafeList(value, depth + 1)
    : projectSafeRecord(value, depth + 1);
}

function projectSafeText(value: string): string {
  const cleaned = redactInlineSecret(value);
  return SECRET_LITERAL.test(cleaned) ? "…" : compactHeadAndTail(cleaned, 160);
}

function projectSafeList(value: readonly unknown[], depth: number): unknown[] {
  const sample = value.length <= 6
    ? value
    : [...value.slice(0, 3), `${value.length - 6} items omitted`, ...value.slice(-3)];
  return sample.map((entry) => projectSafeValue(entry, undefined, depth));
}

function projectSafeRecord(value: object, depth: number): Record<string, unknown> {
  const fields = Object.entries(value);
  const sample: [string, unknown][] = fields.length <= 12
    ? fields
    : [...fields.slice(0, 6), ["…", `${fields.length - 12} fields omitted`], ...fields.slice(-6)];
  return Object.fromEntries(sample.map(([key, entry]) => [
    compact(key, 60),
    projectSafeValue(entry, key, depth),
  ]));
}

export function summarizeSlateMcpAutoReviewAction(args: {
  readonly serverDisplayName: string;
  readonly toolName: string;
  readonly mcpArguments?: unknown;
}): string {
  const safeServer = compact(args.serverDisplayName, 80);
  const safeTool = compact(args.toolName, 80);
  const payload = redactMcpValue(args.mcpArguments ?? {}, undefined);
  const details = compactHeadAndTail(JSON.stringify(payload), 300);
  return `Run ${safeTool || "an action"} via ${safeServer || "a connected service"} with ${details}`;
}

export function genericSlateMcpAutoReviewSummary(serverDisplayName: string): string {
  const safeServer = compact(serverDisplayName, 80);
  return safeServer.length > 0 ? `Connect to ${safeServer}` : "Use a connected service";
}

export { SAFE_DESTINATION_FIELDS as MCP_DESTINATION_KEYS };

const ACTION_VERBS = new Set([
  "send", "create", "update", "delete", "post", "write", "read", "add", "remove", "open", "close",
  "list", "search", "fetch", "get", "set", "upload", "download", "invite", "share",
]);

function articleFor(noun: string): "a" | "an" {
  const word = noun.toLowerCase();
  return /^[aeiou]/.test(word) && !/^(user|uni|use)/.test(word) ? "an" : "a";
}

export function humanizeMcpToolAction(toolName: string): string | undefined {
  const words = compact(toolName, 80)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_.]+/g, " ")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  if (words.length === 0) return undefined;
  const [verb, noun] = words;
  if (words.length === 2 && verb !== undefined && noun !== undefined && ACTION_VERBS.has(verb) && !/s$/i.test(noun)) {
    return `${verb} ${articleFor(noun)} ${noun}`;
  }
  return words.join(" ");
}

export function mentionsServer(text: string, serverDisplayName: string): boolean {
  const server = serverDisplayName.trim();
  return server.length > 0 && text.toLowerCase().includes(server.toLowerCase());
}

export function safeMcpDestinationHint(mcpArguments: unknown): string | undefined {
  if (mcpArguments === undefined || mcpArguments === null || typeof mcpArguments !== "object" || Array.isArray(mcpArguments)) return undefined;
  for (const [rawKey, value] of Object.entries(mcpArguments)) {
    if (typeof value !== "string") continue;
    const key = rawKey.replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (!SAFE_DESTINATION_FIELDS.has(key) || SECRET_FIELD.test(rawKey)) continue;
    const redacted = redactInlineSecret(value).replace(/\s+/g, " ").trim();
    if (redacted.length === 0 || redacted.length > 80 || SECRET_LITERAL.test(redacted)) continue;
    return compact(redacted, 60);
  }
  return undefined;
}

export function fallbackSlateMcpAutoReviewSummary(args: {
  readonly serverDisplayName: string;
  readonly toolName: string;
  readonly mcpArguments?: unknown;
}): string {
  const server = compact(args.serverDisplayName, 80);
  const action = humanizeMcpToolAction(args.toolName);
  const hint = safeMcpDestinationHint(args.mcpArguments);
  if (server.length === 0 && action === undefined) return "Use a connected service";
  if (action === undefined) return genericSlateMcpAutoReviewSummary(server);
  const base = server.length > 0 ? `Ask ${server} to ${action}` : `Ask a connected service to ${action}`;
  if (hint === undefined || base.toLowerCase().includes(hint.toLowerCase())) return base;
  return `${base} in ${hint}`;
}

export function describeSlateMcpAutoReviewAction(args: {
  readonly description?: string;
  readonly serverDisplayName: string;
  readonly toolName: string;
  readonly mcpArguments?: unknown;
}): string {
  const description = args.description?.replace(/\s+/g, " ").trim();
  const server = compact(args.serverDisplayName, 80);
  if (description !== undefined && description.length > 0) {
    const head = description.replace(/[.!?]+$/u, "");
    if (server.length > 0 && !mentionsServer(head, server)) return compact(`${head} with ${server}`, 340);
    return compact(head, 340);
  }
  return fallbackSlateMcpAutoReviewSummary({
    serverDisplayName: args.serverDisplayName,
    toolName: args.toolName,
    ...(args.mcpArguments === undefined ? {} : { mcpArguments: args.mcpArguments }),
  });
}

export function summarizeSlateAutomationWriteAction(args: {
  readonly operation: string;
  readonly name: string;
  readonly triggerDescription: string;
  readonly prompt: string;
  readonly isEnabled?: boolean;
  readonly referencingRoutineNames?: readonly string[];
}): string {
  const routineName = compact(args.name, 80) || "a routine";
  const instruction = compactHeadAndTail(redactInlineSecret(args.prompt), 240);
  if (args.operation === "workflow_body") {
    const relatedRoutines = args.referencingRoutineNames
      ?.map((routine) => compact(routine, 40))
      .filter((routine) => routine.length > 0)
      .slice(0, 3)
      .join(", ") || "standing orders";
    return `Update workflow “${routineName}” used by ${relatedRoutines}: “${instruction}”`;
  }
  const timing = (compact(args.triggerDescription, 120) || "when triggered").toLowerCase();
  const verb = args.operation === "create" ? "Create routine" : "Update routine";
  const paused = args.isEnabled === false ? " (paused)" : "";
  return `${verb} “${routineName}”${paused} to run ${timing}: “${instruction}”`;
}

export function summarizeSlateCloudAgentAction(args: {
  readonly action: string;
  readonly prompt: string;
  readonly agentId?: string;
  readonly imageCount?: number;
  readonly interrupt?: boolean;
  readonly repoUrl?: string;
  readonly title?: string;
}): string {
  const instruction = compactHeadAndTail(redactInlineSecret(args.prompt), 240);
  const imageCount = args.imageCount ?? 0;
  const images = imageCount > 0 ? ` with ${imageCount} image${imageCount === 1 ? "" : "s"}` : "";
  if (args.action === "reply") {
    const target = compact(args.agentId ?? "", 40) || "a cloud agent";
    const interrupt = args.interrupt === true ? " (interrupt)" : "";
    return `Send more instructions to cloud agent ${target}${interrupt}${images}: “${instruction}”`;
  }
  const repo = compact(args.repoUrl ?? "", 120);
  const titled = args.title !== undefined && args.title.trim().length > 0 ? ` “${compact(args.title, 80)}”` : "";
  const where = repo.length > 0 ? ` on ${repo}` : "";
  return `Start a cloud agent${titled}${where}${images}: “${instruction}”`;
}

export type CloudLifecycleAction = "rename" | "cancel" | "archive" | "unarchive" | "delete";

export function summarizeSlateCloudAgentLifecycleAction(args: {
  readonly action: CloudLifecycleAction;
  readonly agentId: string;
  readonly title?: string;
}): string {
  const target = compact(args.agentId, 40) || "a cloud agent";
  switch (args.action) {
    case "rename": {
      const title = args.title !== undefined && args.title.trim().length > 0 ? ` as “${compact(args.title, 80)}”` : "";
      return `Rename cloud agent ${target}${title}`;
    }
    case "cancel": return `Stop the active run for cloud agent ${target}`;
    case "archive": return `Archive cloud agent ${target}`;
    case "unarchive": return `Restore cloud agent ${target} to the active list`;
    case "delete": return `Delete cloud agent ${target} permanently`;
  }
}

export function summarizeSlateSubagentAction(args: { readonly action: string; readonly prompt: string }): string {
  const instruction = compactHeadAndTail(redactInlineSecret(args.prompt), 240);
  return args.action === "steer"
    ? `Send a follow-up to the running task: “${instruction}”`
    : `Start a task in Slate's hosted workspace: “${instruction}”`;
}

export interface SlateBrowserSummaryArgs {
  readonly op: string;
  readonly element?: string;
  readonly targetPageUrl?: string;
  readonly url?: string;
  readonly text?: string;
  readonly value?: string;
  readonly values?: readonly string[];
  readonly key?: string;
  readonly cdpMethod?: string;
  readonly cdpParams?: string;
  readonly tabsAction?: string;
  readonly tabIndex?: number;
}

export function summarizeSlateBrowserAutoReviewAction(args: SlateBrowserSummaryArgs): string {
  const elementName = args.element?.replace(/\s+/g, " ").trim();
  const element = elementName !== undefined && elementName.length > 0 ? `“${compact(elementName, 160)}”` : "an element";
  const page = args.targetPageUrl !== undefined && args.targetPageUrl.length > 0
    ? ` on ${compactHeadAndTail(redactInlineSecret(args.targetPageUrl), 120)}`
    : "";
  const describe = (action: string) => compact(`${action}${page} in Slate's hosted browser`, 340);
  switch (args.op) {
    case "navigate": return compact(`Navigate to “${redactInlineSecret(args.url ?? "")}” in Slate's hosted browser`, 340);
    case "click":
    case "mouse_click_xy": return describe(`Click ${element}`);
    case "type": return describe(summarizeTypedText(args.text ?? ""));
    case "fill": return describe(summarizeTypedText(args.value ?? ""));
    case "select_option": return describe(`Select “${redactInlineSecret((args.values ?? []).join(", "))}” in ${element}`);
    case "press_key": return describe(`Press ${args.key?.slice(0, 80) ?? "a key"}`);
    case "drag": return describe(`Drag ${element}`);
    case "cdp": return describe(`Call ${args.cdpMethod?.slice(0, 120) ?? "browser protocol"} with ${compactHeadAndTail(redactInlineSecret(args.cdpParams ?? "{}"), 160)}`);
    case "tabs": return describe(args.tabsAction === "close"
      ? `Close browser tab${args.tabIndex !== undefined ? ` ${args.tabIndex}` : ""}`
      : "Open a browser tab");
    default: return compact(`Browser action ${args.op} in Slate's hosted browser`, 340);
  }
}

export function summarizeTypedText(text: string): string {
  const scrubbed = redactInlineSecret(text);
  const preview = compactHeadAndTail(scrubbed, 80);
  const looksSensitive = scrubbed !== text
    || SECRET_LITERAL.test(text.trim())
    || (SECRET_FIELD.test(text) && /[:=]/.test(text))
    || (/^[A-Za-z0-9+/_=-]{24,}$/.test(text.trim()) && !text.trim().includes(" "));
  if (looksSensitive || preview.length === 0) return `Enter ${text.length} characters`;
  return `Enter ${text.length} characters (“${preview}”)`;
}

export function summarizeSlateComputerTypedText(text: string): string {
  return `${summarizeTypedText(text)} in Slate's hosted workspace`;
}
