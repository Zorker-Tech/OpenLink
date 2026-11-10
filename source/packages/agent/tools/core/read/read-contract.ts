import type { Context } from "../../../../context/context.ts"
import type { HookContextEntry } from "../../../../hooks-carriers/hook-additional-context.ts"

export interface ReadFormattingOptions {
  readonly shouldUseFormatCodeblock?: boolean
  readonly gpt5StyleLineNumbers?: boolean
  readonly gpt5CodexCatN?: boolean
  readonly enableLineNumbers?: boolean
  readonly sparseLineNumbers?: number
  readonly useSparseReadLineNumbers?: boolean
}

export interface ReadSkillReminderModel {
  readonly fullPath?: string
  readonly description?: string
}

/** Values the read feature understands without depending on a transport or generated schema. */
export interface ReadRangeModel {
  startLine: number
  endLine: number
}

export interface ReadRuleModel {
  fullPath?: string
  content: string
}

export type ReadOutputModel =
  | { case: "content"; value: string }
  | { case: "data"; value: Uint8Array }
  | { case: "dataBlobId"; value: Uint8Array }
  | { case: "contentBlobId"; value: Uint8Array }

export interface ReadToolSuccessModel {
  output?: ReadOutputModel
  isEmpty?: boolean
  exceededLimit?: boolean
  totalLines?: number
  fileSize?: number
  path: string
  readRange?: ReadRangeModel
  includeLineNumbers?: boolean
  relatedRulePaths?: string[]
  relatedRules?: ReadRuleModel[]
}

export type ReadToolResultModel = {
  result?:
    | { case: "success"; value: ReadToolSuccessModel }
    | { case: "error"; value: { errorMessage: string } }
    | { case: undefined; value?: undefined }
}

export interface ReadToolArgumentsModel {
  path: string
  offset?: number
  limit?: number
  includeLineNumbers?: boolean
}

export interface ReadToolCallModel {
  args?: ReadToolArgumentsModel
  result?: ReadToolResultModel
}

export interface ReadExecutionRequest {
  path: string
  toolCallId: string
  offset?: number
  limit?: number
}

export type ReadExecutionOutputModel =
  | { case: "content"; value: string }
  | { case: "data"; value: Uint8Array }

export interface ReadExecutionSuccessModel {
  path: string
  totalLines: number
  fileSize: number
  output?: ReadExecutionOutputModel
  outputBlobId?: Uint8Array
  rangeApplied: boolean
}

export type ReadExecutionResultModel = {
  result:
    | { case: "success"; value: ReadExecutionSuccessModel }
    | { case: "error"; value: { error: string } }
    | { case: "rejected"; value: { reason: string } }
    | { case: "fileNotFound"; value: { path: string } }
    | { case: "permissionDenied"; value: { path: string } }
    | { case: "invalidFile"; value: { reason: string } }
    | { case: undefined; value?: undefined }
}

export interface ReadExecutorOptions {
  execId: string
  hookContextCollector?: HookContextEntry[]
}

export interface ReadExecutorPort {
  execute(context: Context, request: ReadExecutionRequest, options: ReadExecutorOptions): Promise<ReadExecutionResultModel>
}

export interface ReadConversationPort {
  executeToolCall(
    context: Context,
    call: ReadToolCallModel,
    callId: string,
    execute: (context: Context) => Promise<ReadToolResultModel>,
    hookContextCollector?: HookContextEntry[],
  ): Promise<ReadToolResultModel>
}
