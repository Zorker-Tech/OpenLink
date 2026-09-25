/**
 * The UI elements the user picked out of a running app.
 *
 * A picked element is described two ways depending on what it is: a React component is named with its
 * props, and anything else with its markup and its text. Props are parsed rather than passed through as
 * text, because the model reads them as data — and a payload that does not parse is reported as invalid
 * rather than dropped, since an element whose props are missing looks like an element that has none.
 *
 * The xpath travels with each element because it is what makes the selection actionable: the agent can
 * point at the same element again.
 */

import type { SelectedUIElement } from "../../proto/generated/agent/v1/selected_context_pb.ts"

export interface SelectedUIElementsTextContent {
  readonly type: "text"
  readonly text: string
}

export function renderSelectedUIElementsContext(
  uiElements: readonly SelectedUIElement[],
): SelectedUIElementsTextContent | undefined {
  if (uiElements.length === 0) return undefined
  const uiElementsText = uiElements.map(uiElement => {
    if (uiElement.component !== undefined && uiElement.component !== "") {
      let parsedProps: unknown
      if (uiElement.componentPropsJson !== undefined && uiElement.componentPropsJson !== "") {
        try {
          parsedProps = JSON.parse(uiElement.componentPropsJson)
        } catch (_error) {
          parsedProps = { error: "Invalid JSON" }
        }
      }
      return `<ui_element>
React Component: ${uiElement.component}
Props: ${parsedProps ? JSON.stringify(parsedProps, null, 2) : "None"}
xpath: ${uiElement.xpath}
</ui_element>`
    }
    return `<ui_element>
${uiElement.element}
xpath: ${uiElement.xpath}
textContent: ${uiElement.textContent}
</ui_element>`
  }).join("\n\n")
  return {
    type: "text",
    text: `<selected_ui_elements>
The following UI elements have been selected by the user from the runtime.
${uiElementsText}
</selected_ui_elements>`,
  }
}
