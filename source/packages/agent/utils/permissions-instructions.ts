/**
 * Turning the stored permissions into the instructions an agent runs under.
 *
 * Permissions arrive as three layers — what the user allowed, what the project allows, and what an
 * administrator imposed — and the administrator's layer wins outright when it is present: that is the
 * point of it. Empty entries are dropped rather than passed on, because an empty allow or block line
 * reads to a model as an instruction it cannot follow.
 */

export interface PermissionsAutoRunInstructions {
  readonly allowInstructions: readonly string[]
  readonly blockInstructions: readonly string[]
}

export interface SmartModeAutoRunInstructionProtos {
  readonly userPermissionsAutoRun?: PermissionsAutoRunInstructions
  readonly projectPermissionsAutoRun?: PermissionsAutoRunInstructions
  readonly adminPermissionsAutoRun?: PermissionsAutoRunInstructions
}

export interface SmartModeAutoRunInstructions {
  readonly userAutoRunInstructions?: PermissionsAutoRunInstructions | undefined
  readonly projectAutoRunInstructions?: PermissionsAutoRunInstructions | undefined
  readonly hasAdminOverride: boolean
}

/** Drops empty entries, and reports "nothing to say" as absent rather than as two empty lists. */
export function projectPermissionsAutoRunFromProto(
  instructions: PermissionsAutoRunInstructions | undefined,
): PermissionsAutoRunInstructions | undefined {
  if (instructions === undefined) return undefined
  const allowInstructions = instructions.allowInstructions.filter(instruction => instruction.length > 0)
  const blockInstructions = instructions.blockInstructions.filter(instruction => instruction.length > 0)
  if (allowInstructions.length === 0 && blockInstructions.length === 0) return undefined
  return { allowInstructions, blockInstructions }
}

export function smartModeAutoRunInstructionsFromProtos({
  userPermissionsAutoRun,
  projectPermissionsAutoRun,
  adminPermissionsAutoRun,
}: SmartModeAutoRunInstructionProtos): SmartModeAutoRunInstructions {
  const admin = projectPermissionsAutoRunFromProto(adminPermissionsAutoRun)
  if (admin !== undefined) {
    return { projectAutoRunInstructions: admin, hasAdminOverride: true }
  }
  return {
    userAutoRunInstructions: projectPermissionsAutoRunFromProto(userPermissionsAutoRun),
    projectAutoRunInstructions: projectPermissionsAutoRunFromProto(projectPermissionsAutoRun),
    hasAdminOverride: false,
  }
}
