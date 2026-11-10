/** Slate-authored notes the box makes available to its agent. */

export const SLATE_BOX_REFERENCE_DIR = "/home/box/reference"
export const LEGACY_SLATE_BOX_REFERENCE_DIR = "/home/box/slate-reference"
export const DEBUGGING_THE_BOX_FILE = "debugging-the-box.md"
export const SLATE_APP_UI_FILE = "app-ui.md"

export const SLATE_BOX_DEBUGGING_REFERENCE_PATH = `${SLATE_BOX_REFERENCE_DIR}/${DEBUGGING_THE_BOX_FILE}`
export const SLATE_APP_UI_REFERENCE_PATH = `${SLATE_BOX_REFERENCE_DIR}/${SLATE_APP_UI_FILE}`

export const SLATE_BOX_DEBUGGING_REFERENCE_DOC = [
  "# Diagnosing the box",
  "",
  "If the isolated computer will not start, shell commands fail, a computerUse helper reports an error, or the desktop preview is blank, investigate the live box before stopping. Keep the user informed with a short status as you check it.",
  "",
  "- First check availability. Any Shell output shows the session is reachable. A notice that the box is still starting or fetching its image is temporary; wait briefly and try again because a first launch can take several minutes. If Shell and Screenshot are absent, the host has not attached a box. Follow the app's local-runtime prompt when it appears.",
  "- Run the bundled health check with `box-doctor`, or inspect its last startup report at `/tmp/box-doctor.log`. It checks the machine identity, installed browser and version, name lookup and outbound access, system time, and the session bus. Each result is marked `[box-doctor] PASS|FAIL <check>: <detail>` and ends with a summary; the same summary is also written to the startup log. Report a failed check instead of guessing at the cause.",
  "- For a blank desktop, use Screenshot to inspect the display and Shell for read-only checks. The primary display is `:1`; `xdpyinfo -display :1` checks whether it is available. The desktop starts without a browser window, so the absence of a browser process is expected until a computerUse helper opens one. The overall launch log is `/tmp/start-desktop.log`; display and viewer services keep their own logs under `/tmp`. If the browser does not start, use the box's supported browser launcher and inspect its output. Do not invoke a raw browser executable or control the desktop from Shell; use the computer tools for interaction.",
  "- Check the runtime type by looking for `/.dockerenv`: its presence indicates a local container, while its absence indicates a remote pod. A local container can be inspected from the host with the host's container-management tools. A remote pod is managed on the service side, so rely on the checks inside the box.",
  "- When a command fails, inspect its error and available space with `df -h /workspace`. Files and installed tools persist between turns; if a tool is missing, reinstall it in the box.",
  `- Retry after transient startup errors. You cannot rebuild the box from inside it. If it remains wedged or uses an unusable image, direct the user to Settings → Updates → "Update Slate's Computer" (button: "Update"). That moves the box to a fresh instance while retaining files and logins. Do not direct them to "Reset Slate's Computer": it restores a saved snapshot and may discard unsynced work. Use request_box_help for a manual step on a working desktop, such as completing a sign-in or captcha; it does not repair a failed box.`,
  "",
].join("\n")

export const SLATE_APP_UI_REFERENCE_DOC = [
  "# Slate interface map",
  "",
  "These are the interface paths an agent can safely describe. Use the listed routes only. If a control is not documented here, say you are unsure instead of inventing a screen or action.",
  "",
  "- Open Settings from the account button at the lower left, with Cmd+, or from the command palette's Open settings action. There is no gear button or system-level Preferences item.",
  "- Delete an agent from its sidebar row: right-click and choose Delete, then confirm. This permanently removes the agent and its transcript. There is no archive or hide action.",
  "- Settings contains General, Plugins, Team Setup, Appearance, and Updates.",
  "- General contains the account card, where the user connects or disconnects an account.",
  "- Plugins has a Search plugins field and Marketplace and Yours views. Marketplace is for browsing; a plugin detail page has Add or Uninstall plus an Accounts card with per-connector authentication. Yours separates Installed plugins from Private skills. Installed rows show connection state and an Authenticate action when needed. Private skills have a per-agent enable switch; opening one lets the user edit its name, description, and instructions or delete it.",
  "- Team Setup contains scripts installed on every computer assigned to the current team.",
  "- Appearance has the Theme selector with System, Light, and Dark choices.",
  `- Updates contains "Update Slate's Computer" (button: "Update", followed by a second confirmation), which creates a fresh box while keeping files and logins. "Reset Slate's Computer" (button: "Reset") restores the last saved snapshot and can lose recent unsynced work; describe it only as a last resort. "Update Track" selects Stable or Nightly, and "Check for Updates" updates the app itself rather than the box.`,
  `- The per-agent information pane is separate from Settings. Open it by selecting the agent name in the chat header or pressing Cmd+Shift+I; close it with the pane's own X button. It contains the live computer preview, Routines, available Channels, and group-chat Members. The gear beside X opens that agent's Settings page for avatar, name, title, description, and notification choices.`,
  "",
].join("\n")

export const SLATE_BOX_REFERENCE_DOCS = [
  { fileName: DEBUGGING_THE_BOX_FILE, contents: SLATE_BOX_DEBUGGING_REFERENCE_DOC },
  { fileName: SLATE_APP_UI_FILE, contents: SLATE_APP_UI_REFERENCE_DOC },
] as const
