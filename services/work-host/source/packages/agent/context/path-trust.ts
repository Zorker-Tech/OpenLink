import path from "node:path"

import type { Context } from "../../context/context.ts"
import { createLogger } from "../../context/logging.ts"
import { resolveTrustedAttachmentCandidate } from "./path-trust-policy.ts"
import type { AttachmentKind, AttachmentPathRequestContext, TrustedPathOnlyAttachmentResult } from "./path-trust-contracts.ts"

export type { AttachmentKind, AttachmentPathEnvironment, AttachmentPathRequestContext, TrustedPathOnlyAttachmentResult } from "./path-trust-contracts.ts"

const logger = createLogger("agent/context-processing")

export async function resolveTrustedPathOnlyAttachmentPath(
  context: Context,
  readablePath: string,
  requestContext: AttachmentPathRequestContext | undefined,
  attachmentKind: AttachmentKind,
  treatNonAbsoluteAsPathOnly: boolean,
): Promise<TrustedPathOnlyAttachmentResult> {
  const pathOnlyPayload = readablePath.length > 0 && (treatNonAbsoluteAsPathOnly || path.isAbsolute(readablePath))
  if (!pathOnlyPayload) return { hasPathOnlyPayload: false, trustedPath: undefined }

  const trustedPath = await resolveTrustedAttachmentCandidate(readablePath, requestContext, attachmentKind)
  if (trustedPath === undefined) logger.warn(context, `Ignoring untrusted path-only ${attachmentKind} attachment`)
  return { hasPathOnlyPayload: true, trustedPath }
}
