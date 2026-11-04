export interface PermissionsAutoRunInstructions {
  readonly allowInstructions: readonly string[]
  readonly blockInstructions: readonly string[]
}

export interface Permissions {
  readonly allow: readonly string[]
  readonly deny: readonly string[]
}

export interface EffectivePermissions extends Permissions {
  readonly approvalMode: "unrestricted"
  readonly userConfiguredPolicy: { readonly type: "insecure_none" }
}

export type PermissionsTransformer = (permissions: Permissions) => Permissions | void

export interface DecodedPermissionsFile {
  readonly permissions: Permissions
  readonly autoRunInstructions: PermissionsAutoRunInstructions
}
