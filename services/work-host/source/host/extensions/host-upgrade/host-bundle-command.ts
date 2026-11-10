import { mkdir, rename, writeFile } from "node:fs/promises";
import { buildSlateSupervisorCommand, serializeSlateSupervisorCommand } from "./host-bundle-upgrade-command-values.ts";
import {
  SLATE_SUPERVISOR_COMMAND_PART_PATH,
  SLATE_SUPERVISOR_COMMAND_PATH,
  SLATE_SUPERVISOR_DIR,
  SLATE_SUPERVISOR_STAGED_BUNDLE_PART_PATH,
  SLATE_SUPERVISOR_STAGED_BUNDLE_PATH,
  type SlateSupervisorUpgradeCommand,
  type StageHostBundleInput,
} from "./host-bundle-upgrade-contracts.ts";

export { buildSlateSupervisorCommand, serializeSlateSupervisorCommand };

function stagingPaths(input: StageHostBundleInput) {
  const root = input.dir ?? SLATE_SUPERVISOR_DIR;
  const bundlePath = input.stagedBundlePath ?? SLATE_SUPERVISOR_STAGED_BUNDLE_PATH;
  const bundlePartPath = input.stagedBundlePartPath ?? SLATE_SUPERVISOR_STAGED_BUNDLE_PART_PATH;
  const commandPath = input.commandPath ?? SLATE_SUPERVISOR_COMMAND_PATH;
  const commandPartPath = input.commandPartPath ?? SLATE_SUPERVISOR_COMMAND_PART_PATH;
  return { root, bundlePath, bundlePartPath, commandPath, commandPartPath };
}

export async function stageHostBundleUpgrade(input: StageHostBundleInput): Promise<SlateSupervisorUpgradeCommand> {
  const paths = stagingPaths(input);
  const command = buildSlateSupervisorCommand({
    id: `upgrade-${input.version}`,
    kind: "upgrade",
    nowMs: input.nowMs ?? Date.now(),
    mode: "bundle",
    version: input.version,
    bundlePath: paths.bundlePath,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.forceNow === undefined ? {} : { forceNow: input.forceNow }),
  });

  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.bundlePartPath, input.bytes);
  await rename(paths.bundlePartPath, paths.bundlePath);
  await writeFile(paths.commandPartPath, serializeSlateSupervisorCommand(command));
  await rename(paths.commandPartPath, paths.commandPath);
  return command;
}
