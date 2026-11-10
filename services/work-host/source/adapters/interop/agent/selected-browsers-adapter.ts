import type { SelectedBrowser } from "../proto/generated/agent/v1/selected_context_pb.ts";
import type { BrowserTabPromptInput } from "../../../packages/agent/context/selected-browsers-context.ts";

export function toBrowserTabPromptInputs(tabs: readonly SelectedBrowser[]): BrowserTabPromptInput[] {
  return tabs.map(tab => ({
    url: tab.url,
    browserId: tab.browserId,
    ...(tab.pageTitle === undefined ? {} : { pageTitle: tab.pageTitle }),
  }));
}
