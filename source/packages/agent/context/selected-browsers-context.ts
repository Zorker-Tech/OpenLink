/**
 * The browser tabs the user attached.
 *
 * A tab is not a file: the agent cannot read it by path, and the identifier the browser tools take is not
 * something it could guess. So each tab is named by its title and its URL — which is what the user sees —
 * together with the identifier the tools need, so the agent can act on the tab the user is looking at
 * rather than opening its own.
 */

import type { SelectedBrowser } from "../../proto/generated/agent/v1/selected_context_pb.ts"

export interface SelectedBrowsersTextContent {
  readonly type: "text"
  readonly text: string
}

export function renderSelectedBrowsersContext(
  selectedBrowsers: readonly SelectedBrowser[],
): SelectedBrowsersTextContent | undefined {
  if (selectedBrowsers.length === 0) return undefined
  const browsersText = selectedBrowsers.map(browser => {
    const title = browser.pageTitle || "Untitled"
    return `- ${title}
  URL: ${browser.url}
  Browser ID: ${browser.browserId}`
  }).join("\n")
  return {
    type: "text",
    text: `<browser_context>
The user has attached the following browser tab(s) as context. You can use the Browser ID to interact with these tabs using browser tools:
${browsersText}
</browser_context>`,
  }
}
