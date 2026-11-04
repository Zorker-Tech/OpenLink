export {
  SLATE_TOOL_MARKER,
  buildErrorResult,
  buildSuccessResult,
  completedToolCall,
  emptyToolCall,
  encodeError,
  encodeSlateStep,
  encodeSuccess,
  serializedErrorToolCall,
  toolCallWrapper,
  type CommunicateResult,
  type CommunicateToolCall,
} from "./communicate-tool-protocol-adapter.ts"

export {
  defineCommunicateTool,
  makeCommunicateRender as makeRender,
  type CommunicateActivity,
  type CommunicateInteractionHandler,
  type CommunicateToolSpec,
} from "../../../host/runner/tools/communicate-tool.ts"
