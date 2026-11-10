import type { SelectedDocumentation } from "../proto/generated/agent/v1/selected_context_pb.ts"
import type { Context } from "../../../packages/context/context.ts"
import { hydrateDocumentation, type DocumentationHydrationService } from "../../../packages/agent/context/documentation-hydration.ts"

/** Convert selected-context document records into Slate's application reference shape before hydration. */
export function hydrateSelectedDocumentation<TResult>(input: {
  readonly ctx: Context
  readonly documentations: readonly SelectedDocumentation[]
  readonly documentationHydrationService: DocumentationHydrationService<TResult>
  readonly conversationQuery: unknown
}): Promise<TResult | undefined> {
  const references = input.documentations.map(document => ({
    id: document.docId,
    displayName: document.name,
  }))
  return hydrateDocumentation(input.ctx, references, input.documentationHydrationService, input.conversationQuery)
}
