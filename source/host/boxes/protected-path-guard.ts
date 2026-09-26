/**
 * Refusing a path inside a store that belongs to the host.
 *
 * Some directories are the host's own — where it keeps its state — and a box must not be pointed at them. A candidate
 * is resolved and compared against each root, and then compared again through its real path, so a symlink into a
 * protected root is refused as well as a plain path.
 */
import { isAbsolute, resolve } from "node:path";
import { isPathWithin, realpathNearestExisting } from "../../shared/node/paths.ts";
export class SlateProtectedPathError extends Error { constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = "SlateProtectedPathError"; } }
export function refusalMessage(path: string): string { return `Path is inside a protected host-only store and was refused: ${path}`; }
export async function assertPathOutsideProtectedRoots(protectedRoots: readonly string[], candidatePath: string, baseDir: string): Promise<void> { if (protectedRoots.length === 0) return; const resolved = isAbsolute(candidatePath) ? resolve(candidatePath) : resolve(baseDir, candidatePath); for (const root of protectedRoots) if (isPathWithin(root, resolved, { isInclusive: true })) throw new SlateProtectedPathError(refusalMessage(candidatePath)); const realResolved = await realpathNearestExisting(resolved); for (const root of protectedRoots) { const realRoot = await realpathNearestExisting(root); if (isPathWithin(realRoot, realResolved, { isInclusive: true })) throw new SlateProtectedPathError(refusalMessage(candidatePath)); } }
