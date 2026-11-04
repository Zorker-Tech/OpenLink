const TOOL_INPUT_ERROR_NAME = "SlateToolInputError";

const ToolInputErrorType = class SlateToolInputError extends Error {
  override readonly name = TOOL_INPUT_ERROR_NAME;
};

export const SlateToolInputError = ToolInputErrorType;
export type SlateToolInputError = InstanceType<typeof ToolInputErrorType>;

