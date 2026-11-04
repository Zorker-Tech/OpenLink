/** The application port used to fetch documents attached to the current turn. */
import type { Context } from "../../context/context.ts"

export interface DocumentationIdentifier {
  readonly id: string
  readonly displayName: string
}

export interface DocumentationHydrationService<TResult = unknown> {
  hydrateDocumentation(
    context: Context,
    documents: readonly DocumentationIdentifier[],
    conversationQuery: unknown,
  ): Promise<TResult>
}

export async function hydrateDocumentation<TResult>(
  context: Context,
  documents: readonly DocumentationIdentifier[],
  service: DocumentationHydrationService<TResult>,
  conversationQuery: unknown,
): Promise<TResult | undefined> {
  if (documents.length === 0) return undefined
  return service.hydrateDocumentation(context, documents, conversationQuery)
}
