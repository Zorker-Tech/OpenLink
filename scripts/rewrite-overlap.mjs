/**
 * How much of the baseline a landed file still reproduces, as a gate on calling it rewritten.
 *
 * A file that was "ported" and a file that was "rewritten in Slate's own logic" look the same in the checklist, so the
 * checklist alone cannot be the evidence for the second claim. This script answers that question with tokens: for every
 * landed file it compares our source against the baseline laid out at the same port path, and reports the share of the
 * baseline's identifier pairs that our file still reproduces.
 *
 * - **overlap** is `common identifier pairs / baseline identifier pairs`. A file that was copied scores 1.0; a file
 *   whose structure, names and decomposition are ours scores low even when it answers the same behaviour.
 * - **bands** group the landed files by that number, so the rewrite pass can run risk-first: the identical files
 *   (largest first), then the near-identical ones, then the rest.
 * - **check** is the gate: no file may be recorded as rewritten in the ledger while it still reproduces the baseline at
 *   or above the threshold. Generated trees and the interop adapters (which must speak the counterpart's wire shape)
 *   are listed below with the reason they are exempt, and the report prints that list so the exemption stays auditable.
 * - a **floor** claim is the third honest book: a file that was rewritten, measured, and found to sit above the threshold
 *   because what is left is the interface other modules call. It needs its measured number and the reason in the ledger,
 *   and `check` refuses a floor claim that could have been a plain rewrite — a floor is a finding, not a shelter.
 *
 * The baseline is local-only and never committed (`reference/` is git-ignored): on a machine without it this script
 * says so and does nothing. It reads the layout the port created — `reference/tools/port-layout.json` — and the
 * rewrite state in `reference/rewrite-checklist.json` / `reference/rewrite-ledger.json`.
 *
 *   node scripts/rewrite-overlap.mjs report [--threshold 0.8] [--limit 20]
 *   node scripts/rewrite-overlap.mjs queue [--limit 20]          # risk-first rewrite order, largest first
 *   node scripts/rewrite-overlap.mjs check [--threshold 0.8]     # exit 1 when a rewritten file still reproduces
 *   node scripts/rewrite-overlap.mjs file <port>                 # one file's numbers
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baselineDir = path.join(root, "reference", "derived");

/**
 * What the gate does not measure, and why. These are not loopholes: each entry is a path prefix that either is not our
 * source at all (generated from a schema) or is an adapter whose text is dictated by the counterpart's wire shape.
 */
const EXEMPT = [
  ["packages/proto/", "generated from the wire schema by buf; reviewed, never hand-rewritten"],
  ["packages/redacted-protos/", "generated from the redaction annotations; reviewed, never hand-rewritten"],
  ["packages/mcp-core/", "constant tables whose values are the counterpart's wire names"],
  ["packages/agent-store-sync/bcs-transport.ts", "adapter: speaks the counterpart's agent-store wire frame for frame"],
  ["packages/agent-store-sync/bcs-list-adapter.ts", "adapter: the wire's listing shape, mapped one entry at a time"],
  ["packages/agent-store-sync/sync-client-config.ts", "the counterpart's client numbers, recovered as data"],
  ["shared/node/cursor-backend/cursor-inference.ts", "adapter: the backend transport and its endpoint resolution"],
];

const options = new Map();
for (const argument of process.argv.slice(3)) {
  const [flag, value] = argument.split("=");
  if (flag.startsWith("--")) options.set(flag.slice(2), value ?? "true");
}
const threshold = Number(options.get("threshold") ?? 0.8);
const limit = Number(options.get("limit") ?? 20);

const read = (file) => readFile(file, "utf8").catch(() => null);

/** The tokens of a file's code: comments and whitespace gone, strings and identifiers kept as they are written. */
export function codeTokens(code) {
  const withoutComments = code.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
  return withoutComments.match(/[A-Za-z_$][A-Za-z0-9_$]*|\d[\d_.]*|"[^"\n]*"|'[^'\n]*'|`[^`]*`/g) ?? [];
}

/** Consecutive pairs of words, which is what a copy keeps even when it is re-indented or re-ordered. */
function pairs(tokens) {
  const counts = new Map();
  for (let index = 0; index + 1 < tokens.length; index += 1) {
    const key = `${tokens[index]} ${tokens[index + 1]}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export function overlapOf(baselineText, ourText) {
  const baselinePairs = pairs(codeTokens(baselineText));
  const ourPairs = pairs(codeTokens(ourText));
  let total = 0;
  let common = 0;
  for (const [key, count] of baselinePairs) {
    total += count;
    common += Math.min(count, ourPairs.get(key) ?? 0);
  }
  const identical = codeTokens(baselineText).join(" ") === codeTokens(ourText).join(" ");
  return { overlap: total === 0 ? 0 : common / total, baselinePairs: total, identical };
}

const bandOf = (result) => (result.identical ? "identical" : result.overlap >= 0.95 ? ">= 0.95" : result.overlap >= 0.8 ? ">= 0.80" : "< 0.80");
const exemptReason = (port) => EXEMPT.find(([prefix]) => port === prefix || port.startsWith(prefix))?.[1];

async function load() {
  const layout = JSON.parse((await read(path.join(root, "reference", "tools", "port-layout.json"))) ?? "null");
  const checklist = JSON.parse((await read(path.join(root, "reference", "rewrite-checklist.json"))) ?? "null");
  const ledgerText = await read(path.join(root, "reference", "rewrite-ledger.json"));
  if (layout === null || checklist === null) {
    console.log("no baseline checklist here: reference/ is local-only, so this gate only runs where the baseline is laid out");
    process.exit(0);
  }
  const rewritable = new Set(layout.files.map((file) => file.port));
  const ledgerEntries = (ledgerText === null ? { entries: {} } : JSON.parse(ledgerText)).entries;
  // A claim only counts when the file is actually being called rewritten: a withdrawn one is back in the queue, an
  // exempt one was never a rewrite (an adapter, a generated file, or our own file with no baseline), and a floor one was
  // rewritten as far as its interface allows and is recorded with that number and reason instead of as a plain rewrite.
  const claimOf = ([, record]) => record.claim;
  const ledger = new Map(Object.entries(ledgerEntries).filter((entry) => claimOf(entry) !== "withdrawn" && claimOf(entry) !== "exempt" && claimOf(entry) !== "floor").map(([port]) => [port, "rewritten"]));
  const floors = new Map(Object.entries(ledgerEntries).filter((entry) => claimOf(entry) === "floor").map(([port, record]) => [port, record]));
  const landed = [];
  for (const module of checklist.modules) {
    for (const entry of module.entries) {
      if (entry.done !== true) continue;
      landed.push({ port: entry.port, reference: entry.reference, lines: entry.lines, module: module.name, rewritten: entry.rewritten });
    }
  }
  return { landed, rewritable, ledger, floors };
}

/** Where our file for a landed entry lives: a renamed port records its own source path on the entry. */
const sourceOf = (entry) => String(entry.rewritten ?? "").replace(/^source\//, "") || entry.port;

/** Every landed file's numbers, read once so the report, the queue and the gate all speak about the same set. */
async function measure({ landed }) {
  const results = [];
  for (const entry of landed) {
    const reason = exemptReason(entry.port);
    const baseline = (await read(path.join(baselineDir, entry.port))) ?? (await read(path.join(baselineDir, entry.reference)));
    const ours = await read(path.join(root, "source", sourceOf(entry)));
    if (baseline === null || ours === null) {
      results.push({ ...entry, source: sourceOf(entry), missing: baseline === null ? "baseline" : "source", exempt: reason });
      continue;
    }
    results.push({ ...entry, source: sourceOf(entry), ...overlapOf(baseline, ours), exempt: reason });
  }
  return results;
}

const [command = "report", argument] = import.meta.filename === process.argv[1] ? process.argv.slice(2) : ["noop"];

if (command === "file") {
  const result = (await measure(await load())).find((entry) => entry.port === argument || entry.source === argument);
  if (result === undefined) {
    console.log(`${argument}: not landed`);
    process.exit(1);
  }
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

const state = import.meta.filename === process.argv[1] ? await load() : null;
const results = state === null ? [] : await measure(state);

if (command === "check") {
  const violations = results.filter((result) => result.exempt === undefined && state.ledger.has(result.port) && (result.identical === true || result.overlap >= threshold));
  for (const violation of violations) {
    console.log(`VIOLATION ${violation.port}  overlap ${violation.overlap.toFixed(3)}${violation.identical ? " (identical)" : ""} — recorded as rewritten, still reproduces the baseline`);
  }
  // A floor claim is only allowed where it is true: it must say why, and it must actually sit at or above the threshold.
  const floorProblems = [];
  for (const [port, record] of state.floors) {
    const result = results.find((entry) => entry.port === port);
    if (result === undefined) {
      floorProblems.push(`${port}  claimed at the floor but is not a landed file`);
      continue;
    }
    if (typeof record.floorReason !== "string" || record.floorReason.trim().length === 0) floorProblems.push(`${port}  claimed at the floor without saying why`);
    if (result.overlap < threshold) floorProblems.push(`${port}  measured ${result.overlap.toFixed(3)}, below ${threshold}: it can be recorded as rewritten`);
    if (result.exempt !== undefined) floorProblems.push(`${port}  is exempt from the gate, so it cannot also be at the floor`);
    if (typeof record.overlap !== "number") floorProblems.push(`${port}  claimed at the floor without its measured overlap`);
    else if (Math.abs(record.overlap - result.overlap) > 0.01) floorProblems.push(`${port}  recorded at ${record.overlap}, measured ${result.overlap.toFixed(3)}`);
  }
  for (const problem of floorProblems) console.log(`FLOOR ${problem}`);
  for (const violation of violations) {
    console.log(`VIOLATION ${violation.port}  overlap ${violation.overlap.toFixed(3)}${violation.identical ? " (identical)" : ""} — recorded as rewritten, still reproduces the baseline`);
  }
  const rewritten = results.filter((result) => state.ledger.has(result.port)).length;
  const failed = violations.length + floorProblems.length;
  console.log(failed === 0 ? `check: ${rewritten} rewritten files are below ${threshold}, ${state.floors.size} are at the floor; nothing to fix` : `check: ${failed} problem(s) before the ledger may stand as it is`);
  process.exit(failed === 0 ? 0 : 1);
}

const counts = new Map();
for (const result of results) {
  const band = result.exempt !== undefined ? "exempt (adapter/generated)" : result.missing !== undefined ? `no ${result.missing}` : bandOf(result);
  counts.set(band, (counts.get(band) ?? 0) + 1);
}

if (command === "report") {
  const order = ["identical", ">= 0.95", ">= 0.80", "< 0.80", "exempt (adapter/generated)", "no baseline", "no source"];
  console.log(`landed ${results.length} files; token overlap against the baseline\n`);
  for (const band of order) console.log(`  ${String(counts.get(band) ?? 0).padStart(5)}  ${band}`);
  const recorded = results.filter((result) => state.ledger.has(result.port)).length;
  console.log(`\nclaims standing: ${recorded}; still reproducing the baseline at or above ${threshold}: ${results.filter((result) => result.exempt === undefined && state.ledger.has(result.port) && (result.identical === true || result.overlap >= threshold)).length}`);
  const offenders = results
    .filter((result) => result.exempt === undefined && result.identical === true)
    .sort((left, right) => right.lines - left.lines)
    .slice(0, limit);
  if (offenders.length > 0) console.log(`\nidentical to the baseline, largest first (the first rewrite queue):\n${offenders.map((result) => `  ${String(result.lines).padStart(5)}  ${result.port}`).join("\n")}`);
  const near = results.filter((result) => result.exempt === undefined && result.identical !== true && result.overlap >= 0.95).sort((left, right) => right.lines - left.lines).slice(0, limit);
  if (near.length > 0) console.log(`\n>= 0.95, largest first:\n${near.map((result) => `  ${String(result.lines).padStart(5)}  ${result.overlap.toFixed(3)}  ${result.port}`).join("\n")}`);
  const floors = results.filter((result) => state.floors.has(result.port)).sort((left, right) => right.lines - left.lines);
  if (floors.length > 0) {
    console.log(`\nat the floor (rewritten as far as the interface allows):\n${floors.map((result) => `  ${String(result.lines).padStart(5)}  ${result.overlap.toFixed(3)}  ${result.port}  — ${state.floors.get(result.port).floorReason}`).join("\n")}`);
  }
  console.log(`\nexempt from the gate:\n${EXEMPT.map(([prefix, reason]) => `  ${prefix} — ${reason}`).join("\n")}`);
}

if (command === "queue") {
  const bandRank = (result) => (result.identical === true ? 0 : result.overlap >= 0.95 ? 1 : result.overlap >= 0.8 ? 2 : 3);
  const pending = results.filter((result) => result.exempt === undefined && result.missing === undefined && state.ledger.has(result.port) === false && state.floors.has(result.port) === false);
  pending.sort((left, right) => bandRank(left) - bandRank(right) || right.lines - left.lines);
  console.log(`rewrite queue (risk first, then size): ${pending.length} landed files still to rewrite\n`);
  for (const result of pending.slice(0, limit)) {
    console.log(`  ${result.identical ? "identical" : result.overlap.toFixed(3)}  ${String(result.lines).padStart(5)}  ${result.port}`);
  }
}
