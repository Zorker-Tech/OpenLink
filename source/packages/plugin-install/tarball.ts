/**
 * A plugin directory as one artifact.
 *
 * The plugin is packed from its own directory, gzipped and made portable so the same artifact can be unpacked
 * anywhere, and a symlink is left out rather than followed — a link points at something that is not part of this
 * plugin. The archive is built in a temporary file that is removed afterwards, so nothing of the packing outlives it.
 */
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { create } from "tar";

export async function packPluginArtifact(dirPath: string): Promise<Buffer> {
  const archivePath = join(
    await mkdtemp(join(tmpdir(), "slate-plugin-artifact-")),
    "plugin.tgz",
  );
  try {
    const entries = await readdir(dirPath);
    await create({
      cwd: dirPath,
      file: archivePath,
      gzip: true,
      portable: true,
      filter: (_path, stat) => !(
        stat as { isSymbolicLink?: () => boolean }
      ).isSymbolicLink?.(),
    }, entries);
    return await readFile(archivePath);
  } finally {
    await rm(dirname(archivePath), { recursive: true, force: true }).catch(
      () => {},
    );
  }
}
