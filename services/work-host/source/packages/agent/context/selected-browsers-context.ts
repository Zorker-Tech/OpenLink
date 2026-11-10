export interface BrowserTabPromptInput {
  readonly pageTitle?: string | undefined
  readonly url: string
  readonly browserId: string
}

export interface SelectedBrowsersTextContent {
  readonly type: "text"
  readonly text: string
}

function tabTitle(title: string | undefined): string {
  return title || "Untitled"
}

function renderTabReference(tab: BrowserTabPromptInput): string {
  return `- ${tabTitle(tab.pageTitle)}\n  URL: ${tab.url}\n  Browser ID: ${tab.browserId}`
}

export function renderSelectedBrowsersContext(
  tabs: readonly BrowserTabPromptInput[],
): SelectedBrowsersTextContent | undefined {
  if (tabs.length === 0) return undefined

  const references = tabs.map(renderTabReference).join("\n")
  return {
    type: "text",
    text: `<browser_context>\nBrowser tabs selected by the user are listed below. Use each Browser ID to act in the corresponding open tab:\n${references}\n</browser_context>`,
  }
}
