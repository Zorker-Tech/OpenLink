/**
 * Whether the codebase-telemetry helper is there to be run.
 *
 * The helper lives beside the host bundle unless an override names it, and the capability it reports says where it is
 * and whether it can be executed at all.
 */
import { accessSync, constants, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Where a helper with this name lives, when a build lays it out beside the host bundle. */
const HELPER_SEGMENTS: readonly string[] = ["extensions", "codebase-telemetry", "csnaps"];

/** The directory the host bundle was loaded from, in a build that has a `__dirname` to name. */
function hostBundleDirectory(): string {
  return typeof __dirname === "string" ? __dirname : dirname(fileURLToPath(import.meta.url));
}

export function csnapsPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.SLATE_CSNAPS_BIN?.trim();
  if (override) return override;
  return join(hostBundleDirectory(), ...HELPER_SEGMENTS);
}

export function csnapsAvailability(env: NodeJS.ProcessEnv = process.env):
  | { readonly available: true; readonly executablePath: string }
  | { readonly available: false; readonly executablePath: string; readonly reason: "missing" | "not-file" | "not-executable" } {
  const executablePath = csnapsPath(env);
  // Three questions in the order they can be answered: is it there, is it a file, may it be run.
  let isFile: boolean;
  try {
    isFile = statSync(executablePath).isFile();
  } catch {
    return { available: false, executablePath, reason: "missing" };
  }
  if (!isFile) return { available: false, executablePath, reason: "not-file" };
  try {
    accessSync(executablePath, constants.X_OK);
  } catch {
    return { available: false, executablePath, reason: "not-executable" };
  }
  return { available: true, executablePath };
}
