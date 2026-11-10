const MCP_CONFIG_ERROR_NAME = "SlateMcpConfigError";

const McpErrorTypes = {
  SlateMcpConfigError: class extends Error {
    constructor(message: string) {
      super(message);
      this.name = MCP_CONFIG_ERROR_NAME;
    }
  },
};

export const SlateMcpConfigError = McpErrorTypes.SlateMcpConfigError;
export type SlateMcpConfigError = InstanceType<typeof SlateMcpConfigError>;
