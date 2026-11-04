import { SlateBoxMcpUnsupportedError, type BoxMcpPort } from "../../../host/boxes/box-mcp.ts";
import type { Context } from "../../../packages/context/context.ts";

interface GeneratedBoxMcpClient<Request> {
  loadMcpServers(context: Context, request: Request): Promise<{ loadedServerNames: string[] }>;
}

function isUnsupportedServiceOperation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { readonly code?: unknown }).code;
  return code === 12 || code === "unimplemented" || code === "UNIMPLEMENTED";
}

/** Map the generated control call into the host's configuration-level box port. */
export function createBoxMcpPort<Request>(
  client: GeneratedBoxMcpClient<Request>,
  requestFor: (configurationJson: string) => Request,
): BoxMcpPort {
  return {
    async loadServers(context, configurationJson) {
      try {
        const response = await client.loadMcpServers(context, requestFor(configurationJson));
        return response.loadedServerNames;
      } catch (error) {
        if (isUnsupportedServiceOperation(error)) {
          throw new SlateBoxMcpUnsupportedError(undefined, { cause: error });
        }
        throw error;
      }
    },
  };
}
