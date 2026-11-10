/**
 * Spilling a large tool output into a file.
 *
 * An output that is too large to carry in the transcript is written into the agent's own store and replaced by its
 * location, so the model can read the part it needs instead of the whole of it.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";

import { createMcpTextSpillAdapter } from "../../adapters/interop/agent/mcp-text-spill-adapter.ts";
import { MCP_TEXT_FILE_THRESHOLD_BYTES } from "../../packages/agent/tools/mcp/mcp-output-spill-policy.ts";
import { AGENT_TOOLS_DIR, encodeBoundedToolOutput } from "./large-output-spill-policy.ts";

export { AGENT_TOOLS_DIR };
export { MAX_OUTPUT_FILE_SIZE } from "./large-output-spill-policy.ts";

export const SLATE_SHELL_FILE_OUTPUT_THRESHOLD_BYTES = BigInt(MCP_TEXT_FILE_THRESHOLD_BYTES);

export const isLargeOutputSpillEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.SLATE_DISABLE_LARGE_OUTPUT_SPILL !== "1";

export function createSlateMcpTextSpiller<C>(opts: {
  readonly thresholdBytes?: number;
  readonly uploadTextFile: (ctx: C, path: string, data: Uint8Array) => Promise<void>;
}) {
  const thresholdBytes = opts.thresholdBytes ?? MCP_TEXT_FILE_THRESHOLD_BYTES;
  return createMcpTextSpillAdapter<C>({
    thresholdBytes,
    persistText: async (ctx, text) => {
      const relativePath = path.posix.join(AGENT_TOOLS_DIR, `${randomUUID()}.txt`);
      const { bytes, lineCount } = encodeBoundedToolOutput(text);
      await opts.uploadTextFile(ctx, relativePath, bytes);
      return { path: relativePath, byteLength: bytes.byteLength, lineCount };
    },
  });
}
