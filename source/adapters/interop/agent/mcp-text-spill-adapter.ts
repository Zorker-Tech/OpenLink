import { McpResult } from "../proto/generated/agent/v1/mcp_exec_pb.ts"
import { OutputLocation } from "../proto/generated/agent/v1/utils_pb.ts"
import { materializeMcpTextOutput } from "./agent-tools-file-adapter.ts"

export interface PersistedMcpTextFile {
  readonly path: string
  readonly byteLength: number
  readonly lineCount: number
}

export function createMcpTextSpillAdapter<InvocationContext>(options: {
  readonly thresholdBytes: number
  readonly persistText: (context: InvocationContext, text: string) => Promise<PersistedMcpTextFile>
}) {
  return async <Response>(context: InvocationContext, response: Response): Promise<Response> => {
    if (!(response instanceof McpResult) || response.result.case !== "success") return response

    const originalContent = response.result.value.content
    const fileBackedContent = await materializeMcpTextOutput({
      contentItems: originalContent,
      thresholdBytes: options.thresholdBytes,
      write: async (text) => {
        try {
          const stored = await options.persistText(context, text)
          return new OutputLocation({
            filePath: stored.path,
            sizeBytes: BigInt(stored.byteLength),
            lineCount: BigInt(stored.lineCount),
          })
        } catch {
          return undefined
        }
      },
    })
    if (fileBackedContent === undefined || fileBackedContent === originalContent) return response

    const updated = response.clone()
    if (updated.result.case === "success") updated.result.value.content = fileBackedContent
    return updated as Response
  }
}
