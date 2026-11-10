export interface SelectedUIElementInput {
  readonly element: string
  readonly xpath: string
  readonly textContent: string
  readonly component?: string | undefined
  readonly componentPropsJson?: string | undefined
}

export interface SelectedUIElementsTextContent {
  readonly type: "text"
  readonly text: string
}

function componentDescription(input: SelectedUIElementInput): string {
  let props: unknown
  if (input.componentPropsJson !== undefined && input.componentPropsJson !== "") {
    try {
      props = JSON.parse(input.componentPropsJson)
    } catch {
      props = { error: "Invalid JSON" }
    }
  }

  return `<ui_element>\nReact Component: ${input.component}\nProps: ${props ? JSON.stringify(props, null, 2) : "None"}\nxpath: ${input.xpath}\n</ui_element>`
}

function markupDescription(input: SelectedUIElementInput): string {
  return `<ui_element>\n${input.element}\nxpath: ${input.xpath}\ntextContent: ${input.textContent}\n</ui_element>`
}

function describeElement(input: SelectedUIElementInput): string {
  return input.component !== undefined && input.component !== ""
    ? componentDescription(input)
    : markupDescription(input)
}

export function renderSelectedUIElementsContext(
  uiElements: readonly SelectedUIElementInput[],
): SelectedUIElementsTextContent | undefined {
  if (uiElements.length === 0) return undefined

  const descriptions = uiElements.map(describeElement).join("\n\n")
  return {
    type: "text",
    text: `<selected_ui_elements>\nThe following UI elements have been selected by the user from the runtime.\n${descriptions}\n</selected_ui_elements>`,
  }
}
