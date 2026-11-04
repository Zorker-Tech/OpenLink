import type {
  AgentMode,
  SimulatedMsgReason,
} from "../proto/generated/agent/v1/agent_pb.ts"
import type {
  SelectedContext,
  SelectedDocument,
  SelectedImage,
  SelectedVideo,
} from "../proto/generated/agent/v1/selected_context_pb.ts"

/** Wire-facing input types for the selected-context processing boundary. */
export type SelectedContextEntryInterop = SelectedContext
export type SelectedContextEntryModeInterop = AgentMode
export type SelectedContextSimulatedReasonInterop = SimulatedMsgReason
export type SelectedContextImageInterop = SelectedImage
export type SelectedContextVideoInterop = SelectedVideo
export type SelectedContextDocumentInterop = SelectedDocument
