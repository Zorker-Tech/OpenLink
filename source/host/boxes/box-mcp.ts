import type { Context } from "../../packages/context/context.ts";

export const BOX_MCP_UNSUPPORTED_MESSAGE = "Slate's computer is running an older image without MCP support — update it from Settings → Updates → Update Slate's Computer.";

export class SlateBoxMcpUnsupportedError extends Error {
  constructor(message = BOX_MCP_UNSUPPORTED_MESSAGE, options?: ErrorOptions) {
    super(message, options);
    this.name = "SlateBoxMcpUnsupportedError";
  }
}

/** The host's configuration-level port for loading servers into a box. */
export interface BoxMcpPort {
  loadServers(context: Context, configurationJson: string): Promise<string[]>;
}
