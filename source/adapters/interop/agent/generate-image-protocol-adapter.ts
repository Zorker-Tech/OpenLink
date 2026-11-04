import { ToolCall } from "../proto/generated/agent/v1/agent_pb.ts"
import {
  GenerateImageArgs,
  GenerateImageError,
  GenerateImageResult,
  GenerateImageSuccess,
  GenerateImageToolCall,
} from "../proto/generated/agent/v1/generate_image_tool_pb.ts"
import { ReadArgs, type ReadResult } from "../proto/generated/agent/v1/read_exec_pb.ts"
import { WriteArgs, type WriteResult } from "../proto/generated/agent/v1/write_exec_pb.ts"

export type GenerateImageResultInterop = GenerateImageResult
export type GenerateImageToolCallInterop = GenerateImageToolCall
export type GenerateImageEnvelopeInterop = ToolCall

export type ReferenceImageReadViewInterop =
  | { readonly kind: "data"; readonly data: Uint8Array }
  | { readonly kind: "empty" }
  | { readonly kind: "failed" }

export type ImageWriteViewInterop =
  | { readonly kind: "success" }
  | { readonly kind: "error"; readonly error: string }
  | {
      readonly kind: "permission-denied"
      readonly operation: string
      readonly isReadonly: boolean
      readonly error: string
    }
  | { readonly kind: "rejected"; readonly reason: string }
  | { readonly kind: "no-space" }
  | { readonly kind: "unknown" }
  | { readonly kind: "unhandled" }

export type GenerateImageResultViewInterop =
  | { readonly kind: "success"; readonly filePath: string; readonly imageData: string }
  | { readonly kind: "error"; readonly error: string }
  | { readonly kind: "unknown" }

export function createGenerateImageReadArgsInterop(input: {
  readonly path: string
  readonly toolCallId: string
}): InstanceType<typeof ReadArgs> {
  return new ReadArgs(input)
}

export function projectReferenceImageReadResultInterop(
  result: ReadResult,
): ReferenceImageReadViewInterop {
  if (result.result.case !== "success") return { kind: "failed" }
  const output = result.result.value.output
  if (output.case !== "data" || output.value.length === 0) return { kind: "empty" }
  return { kind: "data", data: output.value }
}

export function createGenerateImageWriteArgsInterop(input: {
  readonly path: string
  readonly fileBytes: InstanceType<typeof WriteArgs>["fileBytes"]
}): InstanceType<typeof WriteArgs> {
  return new WriteArgs({
    ...input,
    returnFileContentAfterWrite: false,
  })
}

export function writeResultCaseNameInterop(result: WriteResult): string {
  return result.result.case ?? "undefined"
}

export function projectGenerateImageWriteResultInterop(
  result: WriteResult,
): ImageWriteViewInterop {
  switch (result.result.case) {
    case "success":
      return { kind: "success" }
    case "error":
      return { kind: "error", error: result.result.value.error }
    case "permissionDenied":
      return {
        kind: "permission-denied",
        operation: result.result.value.operation || "unknown",
        isReadonly: result.result.value.isReadonly,
        error: result.result.value.error,
      }
    case "rejected":
      return { kind: "rejected", reason: result.result.value.reason }
    case "noSpace":
      return { kind: "no-space" }
    case undefined:
      return { kind: "unknown" }
    default:
      return { kind: "unhandled" }
  }
}

export function createGenerateImageSuccessInterop(input: {
  readonly filePath: string
  readonly imageData: string
}): GenerateImageResultInterop {
  return new GenerateImageResult({
    result: {
      case: "success",
      value: new GenerateImageSuccess(input),
    },
  })
}

export function createGenerateImageErrorInterop(error: string): GenerateImageResultInterop {
  return new GenerateImageResult({
    result: {
      case: "error",
      value: new GenerateImageError({ error }),
    },
  })
}

export function projectGenerateImageResultInterop(
  result: GenerateImageResultInterop,
): GenerateImageResultViewInterop {
  switch (result.result.case) {
    case "success":
      return {
        kind: "success",
        filePath: result.result.value.filePath,
        imageData: result.result.value.imageData,
      }
    case "error":
      return { kind: "error", error: result.result.value.error }
    case undefined:
      return { kind: "unknown" }
  }
}

export function generateImageResultTextInterop(result: GenerateImageResultInterop): string {
  const view = projectGenerateImageResultInterop(result)
  switch (view.kind) {
    case "success":
      return `Successfully generated image at: ${view.filePath}\nAlways use this absolute path when referring to the image. Do not repeat this image as a Markdown reference; it is already displayed to the user.`
    case "error":
      return `Failed to generate image, error: ${view.error}`
    case "unknown":
      return "An unknown error occurred."
  }
}

export function createGenerateImageToolCallInterop(input: {
  readonly description: string
  readonly referenceImagePaths?: readonly string[]
  readonly filename?: string
  readonly aspectRatio?: string
}): GenerateImageToolCallInterop {
  const args = new GenerateImageArgs({
    description: input.description,
    referenceImagePaths: [...(input.referenceImagePaths ?? [])],
    ...(input.filename === undefined ? {} : { filePath: input.filename }),
    ...(input.aspectRatio === undefined ? {} : { aspectRatio: input.aspectRatio }),
  })
  return new GenerateImageToolCall({ args })
}

export function mergeGenerateImageToolCallInterop(
  baseCall: GenerateImageToolCallInterop,
  result: GenerateImageResultInterop,
): GenerateImageToolCallInterop {
  return new GenerateImageToolCall({ ...baseCall, result })
}

export function emptyGenerateImageToolCallInterop(): GenerateImageToolCallInterop {
  return new GenerateImageToolCall()
}

export function wrapGenerateImageToolCallInterop(
  toolCall: GenerateImageToolCallInterop,
): GenerateImageEnvelopeInterop {
  return new ToolCall({ tool: { case: "generateImageToolCall", value: toolCall } })
}

export function serializeGenerateImageErrorInterop(error: string): GenerateImageEnvelopeInterop {
  return wrapGenerateImageToolCallInterop(
    new GenerateImageToolCall({ result: createGenerateImageErrorInterop(error) }),
  )
}
