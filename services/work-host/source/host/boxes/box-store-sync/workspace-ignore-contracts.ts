export interface WorkspaceIgnore {
  ignores(relPath: string): boolean;
  canPruneDir(relDir: string): boolean;
}

export interface WorkspaceNegationReach {
  readonly everywhere: boolean;
  readonly literalPrefix: string;
}

export interface WorkspaceIgnoreRule {
  readonly negated: boolean;
  readonly fileRe: RegExp;
  readonly dirRe: RegExp;
  readonly negationReach?: WorkspaceNegationReach;
}

export const IGNORE_NOTHING: WorkspaceIgnore = {
  ignores: () => false,
  canPruneDir: () => false,
};
