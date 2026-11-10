import type { SelectedUIElement } from "../proto/generated/agent/v1/selected_context_pb.ts";
import type { SelectedUIElementInput } from "../../../packages/agent/context/ui-elements-context.ts";

export function toSelectedUIElementInputs(
  elements: readonly SelectedUIElement[],
): SelectedUIElementInput[] {
  return elements.map(element => ({
    element: element.element,
    xpath: element.xpath,
    textContent: element.textContent,
    ...(element.component === undefined ? {} : { component: element.component }),
    ...(element.componentPropsJson === undefined
      ? {}
      : { componentPropsJson: element.componentPropsJson }),
  }));
}
