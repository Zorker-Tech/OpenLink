export interface AttachmentPathEnvironment {
  readonly projectFolder?: string | undefined
  readonly workspacePaths: readonly string[]
  readonly artifactsFolder?: string | undefined
}

export interface AttachmentPathRequestContext {
  readonly env?: AttachmentPathEnvironment | undefined
}

export type AttachmentKind = string

export interface TrustedPathOnlyAttachmentResult {
  readonly hasPathOnlyPayload: boolean
  readonly trustedPath: string | undefined
}
