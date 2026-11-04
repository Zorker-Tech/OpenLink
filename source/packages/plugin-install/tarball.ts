import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "tar";

interface TemporaryArchive {
  readonly directory: string;
  readonly file: string;
}

async function allocateArchiveWorkspace(): Promise<TemporaryArchive> {
  const directory = await mkdtemp(join(tmpdir(), "slate-plugin-artifact-"));
  return { directory, file: join(directory, "plugin.tgz") };
}

function includesArchiveEntry(_entryPath: string, entryStats: unknown): boolean {
  const stats = entryStats as { isSymbolicLink?: () => boolean };
  return !stats.isSymbolicLink?.();
}

async function writePluginArchive(sourceDirectory: string, destination: string): Promise<void> {
  const rootEntries = await readdir(sourceDirectory);
  await create({
    cwd: sourceDirectory,
    file: destination,
    gzip: true,
    portable: true,
    filter: includesArchiveEntry,
  }, rootEntries);
}

async function removeArchiveWorkspace(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true }).catch(() => {});
}

export async function packPluginArtifact(sourceDirectory: string): Promise<Buffer> {
  const temporary = await allocateArchiveWorkspace();
  try {
    await writePluginArchive(sourceDirectory, temporary.file);
    return await readFile(temporary.file);
  } finally {
    await removeArchiveWorkspace(temporary.directory);
  }
}
