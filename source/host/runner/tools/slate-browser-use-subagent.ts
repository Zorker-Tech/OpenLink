/**
 * The subagent that drives the box's browser at the page level.
 *
 * Its type is matched loosely, since a caller may spell it with dashes or underscores, and its description tells the
 * model when to prefer it over pixel-level computer use: page snapshots give it exact element targets.
 */

/** The type name this platform gives the page-level browser subagent. */
export const BROWSER_USE_SUBAGENT_TYPE = "browserUse";

/** The punctuation a caller may put in a type name: a dash, an underscore and a space are all the same separator. */
const TYPE_NAME_SEPARATORS = /[-_ ]/g;

/** A type name as this platform compares it: separators dropped, case folded. */
function foldTypeName(value: string): string {
  return value.replace(TYPE_NAME_SEPARATORS, "").toLowerCase();
}

/** The folded spelling of the type this subagent answers to. */
const BROWSER_USE_TYPE_KEY = foldTypeName(BROWSER_USE_SUBAGENT_TYPE);

/** Whether a value names this subagent, however its separators and case are spelled. */
export const isBrowserUseSubagentType = (value: string | null | undefined): boolean =>
  value != null && foldTypeName(value) === BROWSER_USE_TYPE_KEY;

/** What the model is told about the subagent: when to prefer it, and what it cannot do. */
const BROWSER_USE_SUBAGENT_DESCRIPTION_LINES = [
"Delegate a self-contained web task to a background subagent that drives your box's browser at the page level — navigating, reading structured page snapshots, clicking elements by reference, filling forms, and taking screenshots — without touching the desktop's mouse or keyboard.",
"Prefer it over computerUse for browser-only work: page snapshots give it exact element targets, so it is faster and more reliable than pixel clicking, and it shares the box browser's persistent logins.",
"Use computerUse instead when the task needs the desktop itself (GUI apps, file dialogs, drag interactions) or a site that defeats DOM automation.",
"It runs in the background like any Task: you are notified when it finishes, so do not poll or await it.",
"It runs headless and cannot ask follow-ups, so give it a tightly-scoped, self-contained task with the specifics it needs (site, exact values), explicit success criteria, and what to report back.",
"It cannot act as the user: if a step needs a human (a password, 2FA, a captcha, a payment) it stops and reports back, so you can hand the user the box with request_box_help and dispatch it again to continue.",
];

export const BROWSER_USE_SUBAGENT_DESCRIPTION = BROWSER_USE_SUBAGENT_DESCRIPTION_LINES.join(" ");

/** The subagent's configuration, as the runner registers it. */
export const createSlateBrowserUseSubagentConfig = () => {
  const type = { type: { case: "custom", value: { name: BROWSER_USE_SUBAGENT_TYPE } } };
  return {
    subagent_type: type,
    description: BROWSER_USE_SUBAGENT_DESCRIPTION,
    preserveTaskTool: false,
    subagentSource: "builtin" as const,
  };
};
