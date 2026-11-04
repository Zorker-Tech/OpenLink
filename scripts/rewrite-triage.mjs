/**
 * What a rewrite pass needs to know about one landed file, in one command.
 *
 * The per-file work is the same every time — how much of the baseline it still reproduces, who imports it, whether it
 * already has tests, and what the two files differ in — so it is answered here rather than by four greps and an ad-hoc
 * node one-liner. Nothing is changed by this script.
 *
 *   node scripts/rewrite-triage.mjs <port|source path> [--diff 60]
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { overlapOf, sourcePathsOf } from "./rewrite-overlap.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [argument, ...flags] = process.argv.slice(2);
if (argument === undefined) {
  console.log("usage: node scripts/rewrite-triage.mjs <port|source path> [--diff 60]");
  process.exit(1);
}
const diffLines = Number(flags.find((flag) => flag.startsWith("--diff="))?.slice("--diff=".length) ?? 40);

const read = (file) => readFile(path.join(root, file), "utf8").catch(() => null);

/** The landed file's own record: its port, and the source path we laid it down at. */
async function landedEntry(port) {
  const checklist = JSON.parse((await read("reference/rewrite-checklist.json")) ?? "{}");
  for (const module of checklist.modules ?? []) {
    for (const entry of module.entries) {
      if (entry.done !== true) continue;
      if (entry.port === port || entry.rewritten === port || entry.rewritten === `source/${port}`) return entry;
    }
  }
  return null;
}

/** Every file under `source/` that mentions this module's specifier. */
async function consumers(specifier) {
  const found = [];
  const walk = async (directory) => {
    for (const item of await readdir(path.join(root, directory), { withFileTypes: true })) {
      const relative = path.join(directory, item.name);
      if (item.isDirectory()) {
        await walk(relative);
        continue;
      }
      if (!item.name.endsWith(".ts")) continue;
      const text = (await read(relative)) ?? "";
      if (text.includes(specifier)) found.push(relative.replace(/^source\//, ""));
    }
  };
  await walk("source");
  return found;
}

/** The test files that name this module's basename, so a pass knows whether it is adding to or starting a suite. */
async function existingTests(basename) {
  const names = await readdir(path.join(root, "tests", "packages"));
  return names.filter((name) => name.endsWith(".test.ts") && name.includes(basename));
}

const entry = await landedEntry(argument);
if (entry === null) {
  console.log(`${argument}: not a landed file (or the baseline is not laid out here)`);
  process.exit(1);
}
const sources = sourcePathsOf(entry);
const baselineText = (await read(`reference/derived/${entry.port}`)) ?? (await read(`reference/derived/${entry.reference}`));
const ourTexts = await Promise.all(sources.map((source) => read(`source/${source}`)));
const ourText = ourTexts.filter((text) => text !== null).join("\n");
const numbers = baselineText !== null && ourTexts.every((text) => text !== null) ? overlapOf(baselineText, ourTexts) : null;
const ours = sources.map((source) => "source/" + source).join(", ");
const basename = path.basename(sources[0] ?? entry.port).replace(/\.ts$/, "");
const specifier = `/${basename}.ts`;
const importers = await consumers(specifier);
const tests = await existingTests(basename);

console.log(`port        ${entry.port}`);
console.log("ours        " + ours);
console.log(`lines       ${String(ourText?.split("\n").length ?? "?").padStart(5)}  (baseline ${entry.lines})`);
console.log(`overlap     ${numbers === null ? "no baseline" : numbers.overlap.toFixed(3)}${numbers?.identical ? "  identical" : ""}`);
console.log(`importers   ${importers.length}${importers.length > 0 ? `  ${importers.slice(0, 6).join(", ")}${importers.length > 6 ? ", …" : ""}` : ""}`);
console.log(`tests       ${tests.length === 0 ? "none yet" : tests.join(", ")}`);
if (baselineText !== null && ourTexts.every((text) => text !== null) && numbers?.identical !== true) {
  const baselineCode = baselineText.split("\n");
  const ourCode = ourText.split("\n");
  const head = baselineCode.slice(0, diffLines).join("\n");
  console.log(`\nbaseline, first ${diffLines} lines:\n${head}`);
}
