/** The rules an agent considers when deciding whether to run a local action automatically. */
export interface AutoRunPolicyInstructions {
  readonly allowInstructions: readonly string[];
  readonly blockInstructions: readonly string[];
}

/** The three owners whose instructions can shape one smart-mode turn. */
export interface SmartModeAutoRunPermissionLayers {
  readonly user?: AutoRunPolicyInstructions | undefined;
  readonly project?: AutoRunPolicyInstructions | undefined;
  readonly administrator?: AutoRunPolicyInstructions | undefined;
}

export interface SmartModeAutoRunInstructions {
  readonly userAutoRunInstructions?: AutoRunPolicyInstructions | undefined;
  readonly projectAutoRunInstructions?: AutoRunPolicyInstructions | undefined;
  readonly hasAdminOverride: boolean;
}

/** Remove empty entries; an empty list carries no instruction and should remain absent. */
export function normalizeAutoRunPolicyInstructions(
  instructions: AutoRunPolicyInstructions | undefined,
): AutoRunPolicyInstructions | undefined {
  if (instructions === undefined) return undefined;

  const allowInstructions = instructions.allowInstructions.filter(instruction => instruction.length > 0);
  const blockInstructions = instructions.blockInstructions.filter(instruction => instruction.length > 0);
  if (allowInstructions.length === 0 && blockInstructions.length === 0) return undefined;

  return { allowInstructions, blockInstructions };
}

/** An effective administrator rule replaces the lower layers; otherwise user and project rules both apply. */
export function resolveSmartModeAutoRunInstructions({
  user,
  project,
  administrator,
}: SmartModeAutoRunPermissionLayers): SmartModeAutoRunInstructions {
  const override = normalizeAutoRunPolicyInstructions(administrator);
  if (override !== undefined) {
    return { projectAutoRunInstructions: override, hasAdminOverride: true };
  }

  return {
    userAutoRunInstructions: normalizeAutoRunPolicyInstructions(user),
    projectAutoRunInstructions: normalizeAutoRunPolicyInstructions(project),
    hasAdminOverride: false,
  };
}
