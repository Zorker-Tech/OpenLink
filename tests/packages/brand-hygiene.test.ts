/**
 * The platform is ours, all the way down: no file of ours may carry another product's name.
 *
 * This walks our own source — the schema, the generated modules, the host, the agent packages and the
 * shared layer — and refuses the words that belong to the product this platform was rebuilt from. Wire
 * values that a third party really does define (the prompt version a model expects, the identifier of a
 * server another product registers, the `providerOptions` namespace those fields live under) are ours to
 * keep, so they are listed here as the exceptions rather than being left to chance.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const root = new URL("../../source", import.meta.url).pathname.replace(/\/$/, "");

/** A word that belongs to another product: their product, their company, their bug reviewer, their box.
 * Their product name is refused as a whole word too, so a leftover log scope or endpoint path such as
 * `[sand:sharing]` is caught and not only the joined forms. */
const FOREIGN = /(\bGrok|\bgrok|Anysphere|anysphere|Bugbot|bugbot|\bSand\b|\bSand[A-Z]|\bsand\b|\bsand[A-Z_])/;

/** Values a third party defines, which we keep verbatim because they are not ours to rename. */
const KEPT_WIRE_VALUES = [
  "cursor-0226",
  "cursor-app-control",
  "providerOptions.cursor",
  "cursor-browser-extension",
  "CURSOR_AGENT_CLI_LOCAL_MODE",
  ".cursor/rules",
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      out.push(...sourceFiles(path));
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".proto")) {
      out.push(path);
    }
  }
  return out;
}

describe("our own names, all the way down", () => {
  it("no file of ours names another product", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(root)) {
      let text = readFileSync(file, "utf8");
      for (const kept of KEPT_WIRE_VALUES) text = text.split(kept).join("");
      const match = FOREIGN.exec(text);
      if (match !== null) offenders.push(`${file.replace(root, "source")}: ${match[0]}`);
    }
    assert.deepEqual(offenders.slice(0, 20), []);
  });

  it("finds the schema and the generated modules at all, so the walk is not vacuous", () => {
    const files = sourceFiles(root);
    assert.equal(files.some((file) => file.endsWith("schema/aiserver/v1/box.proto")), true);
    assert.equal(files.some((file) => file.endsWith("generated/aiserver/v1/box_pb.ts")), true);
    assert.equal(files.length > 500, true);
  });
});
