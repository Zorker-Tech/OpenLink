/**
 * Refusing a path inside a store that belongs to the host.
 *
 * Some directories are the host's own — where it keeps its state — and a box must not be pointed at them. A candidate
 * is resolved and compared against each root, and then compared again through its real path, so a symlink into a
 * protected root is refused as well as a plain path.
 */
import { isAbsolute, resolve } from "node:path";
import { isPathWithin, realpathNearestExisting } from "../../shared/node/paths.ts";

export class SlateProtectedPathError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SlateProtectedPathError";
  }
}

export function refusalMessage(path: string): string {
  return `Path is inside a protected host-only store and was refused: ${path}`;
}

function resolveCandidate(candidatePath: string, baseDir: string): string {
  return isAbsolute(candidatePath) ? resolve(candidatePath) : resolve(baseDir, candidatePath);
}

function rejectIfLexicallyProtected(roots: readonly string[], candidate: string, originalPath: string): void {
  for (const root of roots) {
    if (isPathWithin(root, candidate, { isInclusive: true })) {
      throw new SlateProtectedPathError(refusalMessage(originalPath));
    }
  }
}

async function rejectIfRealPathIsProtected(
  roots: readonly string[],
  candidate: string,
  originalPath: string,
): Promise<void> {
  const resolvedCandidate = await realpathNearestExisting(candidate);
  for (const root of roots) {
    const resolvedRoot = await realpathNearestExisting(root);
    if (isPathWithin(resolvedRoot, resolvedCandidate, { isInclusive: true })) {
      throw new SlateProtectedPathError(refusalMessage(originalPath));
    }
  }
}

export async function assertPathOutsideProtectedRoots(
  protectedRoots: readonly string[],
  candidatePath: string,
  baseDir: string,
): Promise<void> {
  if (protectedRoots.length === 0) return;
  const candidate = resolveCandidate(candidatePath, baseDir);
  rejectIfLexicallyProtected(protectedRoots, candidate, candidatePath);
  await rejectIfRealPathIsProtected(protectedRoots, candidate, candidatePath);
}
