/** The error an MCP configuration that cannot be used is reported as. */
export class SlateMcpConfigError extends Error { constructor(message: string) { super(message); this.name = "SlateMcpConfigError"; } }
