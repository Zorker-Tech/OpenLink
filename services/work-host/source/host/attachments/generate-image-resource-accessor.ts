/**
 * Where an image the agent generated is written.
 *
 * The file is written under the agent's own assets directory and the same containment check every other attachment
 * path gets, so a write cannot be aimed outside the store; a write that fails is reported with the path it tried.
 */
import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import type { AgentImageResourcePort, AgentImageResourceResult } from "./image-resource-contracts.ts";
import { generatedImageTarget, referenceImageTarget } from "./image-resource-path-policy.ts";

export type { AgentImageResourcePort, AgentImageResourceResult } from "./image-resource-contracts.ts";

function denied(path: string | undefined, message: string): AgentImageResourceResult {
  return { result: { case: "error", value: { ...(path === undefined ? {} : { path }), error: message } } };
}

export function createAgentImageResourcePort(agentDirectory: string): AgentImageResourcePort {
  return {
    async write(request) {
      const target = await generatedImageTarget(agentDirectory, request.path);
      if (target === null) {
        return denied(undefined, "Refused to write the generated image outside the agent's media store.");
      }
      const bytes = Buffer.from(request.fileBytes);
      await fs.mkdir(dirname(target), { recursive: true });
      await fs.writeFile(target, bytes);
      return { result: { case: "success", value: { path: target, fileSize: bytes.length } } };
    },
    async read(request) {
      const resolved = await referenceImageTarget(agentDirectory, request.path);
      if (resolved === null) {
        return denied(request.path, "Refused to read a reference image outside the agent's sandboxed media store.");
      }
      try {
        return { result: { case: "success", value: { data: new Uint8Array(await fs.readFile(resolved)) } } };
      } catch (error) {
        return denied(request.path, error instanceof Error ? error.message : String(error));
      }
    }
  };
}
