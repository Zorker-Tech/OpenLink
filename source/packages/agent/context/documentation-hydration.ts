/**
 * Asking the documentation service for the documents the user attached.
 *
 * The attachment names the documents; the content comes from a service that knows them. Nothing is
 * requested when nothing was attached, and the service is given the conversation as well as the names,
 * because the same document means different things depending on what is being asked.
 */

import type { Context } from "../../context/context.ts"
import type { SelectedDocumentation } from "../../proto/generated/agent/v1/selected_context_pb.ts"

export interface DocumentationIdentifier {
  readonly docId: string
  readonly name: string
}

export interface DocumentationHydrationService<TResult = unknown> {
  hydrateDocumentation(
    ctx: Context,
    documentationIdentifiers: readonly DocumentationIdentifier[],
    conversationQuery: unknown,
  ): Promise<TResult>
}

export interface HydrateDocumentationArgs<TResult = unknown> {
  readonly ctx: Context
  readonly documentations: readonly SelectedDocumentation[]
  readonly documentationHydrationService: DocumentationHydrationService<TResult>
  readonly conversationQuery: unknown
}

export async function hydrateSelectedDocumentation<TResult>({
  ctx,
  documentations,
  documentationHydrationService,
  conversationQuery,
}: HydrateDocumentationArgs<TResult>): Promise<TResult | undefined> {
  if (documentations.length === 0) return undefined
  const documentationIdentifiers = documentations.map(doc => ({ docId: doc.docId, name: doc.name }))
  return documentationHydrationService.hydrateDocumentation(ctx, documentationIdentifiers, conversationQuery)
}
