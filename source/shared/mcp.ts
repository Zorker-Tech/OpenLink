/**
 * The names and identifiers MCP servers are known by.
 *
 * A server's name comes from its configuration and is shown to the user, while the identifiers the platform files it
 * under have to be usable as names: what a server is called is kept as it was given, and what it is filed as is derived
 * from it in a form the platform can use.
 */

/** The account every server that is not filed under another account belongs to. */
export const DEFAULT_MCP_ACCOUNT_KEY = "default";

/** The key a label is compared and stored under: no padding, no case. */
export function normalizeMcpAccountLabel(rawLabel: string): string {
  return rawLabel.trim().toLowerCase();
}

/**
 * The identifier a server is filed under before its account has a real one.
 *
 * Only a server filed under some other account needs the account in its identifier; the default one stands alone.
 */
export function provisionalMcpAccountServerIdentifier(rowIdentifier: string, accountKey: string): string {
  return accountKey === DEFAULT_MCP_ACCOUNT_KEY ? rowIdentifier : `${rowIdentifier}--${accountKey}`;
}

/** How much of a label is rendered where a prompt or a listing is read. */
export const MAX_RENDERED_MCP_ACCOUNT_LABEL_LENGTH = 64;

/** What a label may not carry into a listing: control characters, quotes and the shapes a parser reads as structure. */
export const MCP_LABEL_HOSTILE_CHARS = /[\u0000-\u001f\u007f"'`\\[\]{}()<>\u2028\u2029]/g;

/** One character as the escape a listing can carry it in. */
function asEscape(character: string): string {
  return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
}

/** A label as a quoted argument: every character that would end or escape the quoting is written as its escape. */
export function encodeMcpAccountLabelForListing(label: string): string {
  return `"${label.replace(MCP_LABEL_HOSTILE_CHARS, asEscape)}"`;
}

/** The label inside a quoted argument, or the argument as it came when it is not one quoted string. */
export function decodeMcpAccountLabelArgument(rawArgument: string): string {
  const argument = rawArgument.trim();
  const quoted = argument.length >= 2 && argument.startsWith('"') && argument.endsWith('"');
  if (!quoted) return rawArgument;
  try {
    const parsed: unknown = JSON.parse(argument);
    if (typeof parsed === "string") return parsed;
  } catch {
    // Not the JSON it looked like: handed back as it came.
  }
  return rawArgument;
}

/** A label reduced to what a prompt may show: no quoting or bracketing, single spaces, at most the rendered length. */
export function formatMcpAccountLabelForPrompt(rawLabel: string): string {
  const withoutShapes = rawLabel.replace(/["'`\\[\]{}()<>]/g, "");
  const singleSpaced = withoutShapes.replace(/\s+/g, " ").trim();
  return singleSpaced.slice(0, MAX_RENDERED_MCP_ACCOUNT_LABEL_LENGTH);
}

/** A server's name with the account it is filed under, when that account is not the default one. */
export function formatMcpAccountDisplayName(name: string, accountKey: string | null | undefined): string {
  if (accountKey == null || accountKey === DEFAULT_MCP_ACCOUNT_KEY) return name;
  return `${name} (${formatMcpAccountLabelForPrompt(accountKey)})`;
}

/** Whether a plugin is installed and switched on: the platform counts only the ones that are. */
export function isEffectivePluginInstalled({ isEnabled }: { readonly isEnabled: boolean }): boolean {
  return isEnabled;
}

/** Whether an uninstall left no install record behind: it was removed, or it was the team's server rather than the user's. */
export function uninstallClearedInstallRecord({ removed, reason }: { readonly removed: boolean; readonly reason?: string }): boolean {
  return removed || reason === "team-server";
}

export const MAX_CONNECTOR_ERROR_LENGTH = 300;
export const MAX_UNTRUSTED_MARKUP_SCAN_LENGTH = 16_384;

/** Everything a page's scripts and styles say, which a connector error must not repeat. */
const SCRIPT_OR_STYLE = /<(script|style)\b[^<>]*>[\s\S]*?(?:<\/\1>|$)/gi;
/** Every tag, left as a gap where it stood. */
const ANY_TAG = /<[^<>]*>/g;
/** Any run of whitespace, which reads as one space. */
const ANY_GAP = /\s+/g;

/** The text with its scripts, styles and tags taken out and its gaps collapsed to one space each. */
function readAsPlainText(raw: string): string {
  return raw
    .replace(SCRIPT_OR_STYLE, " ")
    .replace(ANY_TAG, " ")
    .replace(ANY_GAP, " ")
    .trim();
}

/**
 * A connector's error as it may be shown: what the untrusted page wrote, with its markup gone, cut to what a reader
 * will actually look at — and the cut marked, so a truncated sentence is not read as the whole of it.
 */
export function stripMarkupAndBoundConnectorError(raw: string): string {
  const plain = readAsPlainText(raw.slice(0, MAX_UNTRUSTED_MARKUP_SCAN_LENGTH));
  if (plain.length === 0) return "";
  if (plain.length <= MAX_CONNECTOR_ERROR_LENGTH) return plain;
  return `${plain.slice(0, MAX_CONNECTOR_ERROR_LENGTH - 1).trimEnd()}…`;
}
