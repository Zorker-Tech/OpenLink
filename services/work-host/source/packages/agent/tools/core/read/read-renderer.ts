import type { Context } from "../../../../context/context.ts"
import { createImageResult, createStringResult } from "../../../../chat-inference/prompt-executor.ts"
import type { BlobStore } from "../../../../agent-kv/blob-store.ts"
import { toHex, utf8Serde } from "../../../../agent-kv/serde.ts"
import { formatCodeBlock } from "../formatting.ts"
import { isJupyterNotebook } from "../notebook-utils.ts"
import { formatNotebookForLLM } from "./notebook-format.ts"
import { detectImageMimeType } from "./image-utils.ts"
import { READ_OUTPUT_BOUNDS } from "../../read-limits.ts"
import type { ReadFormattingOptions, ReadRuleModel, ReadSkillReminderModel, ReadToolResultModel } from "./read-contract.ts"

const READ_LINE_NUMBER_INTERVAL = 10

export interface ReadRenderProps {
  readonly blobStore?: BlobStore<Context>
}

type ReadPayload =
  | { kind: "text"; content: string }
  | { kind: "binary"; bytes: Uint8Array }
  | { kind: "missing" }

function ruleReminder(rules: readonly ReadRuleModel[]): string | undefined {
  if (rules.length === 0) return undefined
  const rows = rules.map(rule => `- ${rule.fullPath ?? "(unknown rule path)"}\n${rule.content.trimEnd() || "(Rule file is empty.)"}`)
  return ["The following rule files are relevant to the files you just read:", ...rows, "Consider these rules if they affect your changes."].join("\n\n")
}

function skillReminder(skills: readonly ReadSkillReminderModel[]): string | undefined {
  if (skills.length === 0) return undefined
  const rows = skills.map(skill => `- ${skill.fullPath ?? "(unknown skill path)"}\n${skill.description || "(No description)"}`)
  return ["The following skills may be relevant to the files you just read:", ...rows].join("\n\n")
}

function addReminders(content: string, rules: readonly ReadRuleModel[], skills: readonly ReadSkillReminderModel[]): string {
  const notes = [ruleReminder(rules), skillReminder(skills)].filter((value): value is string => value !== undefined)
  return notes.length === 0 ? content : `${content}\n\n${notes.join("\n\n")}`
}

async function payloadFor(
  context: Context,
  output: ReadToolResultModel["result"],
  blobStore: BlobStore<Context> | undefined,
): Promise<ReadPayload> {
  if (output?.case !== "success" || output.value.output === undefined) return { kind: "missing" }
  switch (output.value.output.case) {
    case "content":
      return { kind: "text", content: output.value.output.value }
    case "data":
      return { kind: "binary", bytes: output.value.output.value }
    case "dataBlobId":
    case "contentBlobId": {
      if (blobStore === undefined) throw new Error("Cannot hydrate blobs for tool Read: no blob store available")
      const blobId = output.value.output.value
      const bytes = await blobStore.getBlob(context, blobId)
      if (bytes === undefined) throw new Error(`Failed to hydrate blob ${toHex(blobId)} for tool Read`)
      return output.value.output.case === "dataBlobId"
        ? { kind: "binary", bytes }
        : { kind: "text", content: utf8Serde.deserialize(bytes) }
    }
  }
  return { kind: "missing" }
}

/** Turns Slate's read result into the content the model can consume. */
export function createReadRenderer(formattingOptions: ReadFormattingOptions, sparse: boolean): {
  rememberRelatedSkills(success: object, skills: readonly ReadSkillReminderModel[]): void
  render(context: Context, result: ReadToolResultModel, props?: ReadRenderProps): Promise<unknown>
} {
  const skillsBySuccess = new WeakMap<object, readonly ReadSkillReminderModel[]>()

  return {
    rememberRelatedSkills(success, skills) {
      skillsBySuccess.set(success, skills)
    },
    async render(context, result, props = {}) {
      const response = result.result
      if (response === undefined) return createStringResult("Unknown error", true)
      if (response.case === "error") return createStringResult(`Error: ${response.value.errorMessage}`, true)
      if (response.case !== "success") return createStringResult("Unknown error", true)

      const success = response.value
      if (success.isEmpty) return createStringResult("File is empty.")
      if (success.exceededLimit) {
        return createStringResult(
          `File content (${success.fileSize ?? 0} characters) exceeds maximum allowed characters (${READ_OUTPUT_BOUNDS.maximumCharacters} characters).\nPlease use offset and limit parameters to read specific portions of the file, or use the 'grep' tool to search for specific content.`,
        )
      }

      const payload = await payloadFor(context, response, props.blobStore)
      if (payload.kind === "missing") return createStringResult("Unknown error: no output case", true)
      const skills = skillsBySuccess.get(success) ?? []
      if (payload.kind === "binary") {
        const mimeType = detectImageMimeType(payload.bytes, success.path)
        if (mimeType === undefined) return createStringResult(`Read binary file: ${success.path}`)
        return createImageResult(Buffer.from(payload.bytes).toString("base64"), mimeType, `Read image file: ${success.path}`)
      }
      if (isJupyterNotebook(success.path)) {
        return createStringResult(addReminders(formatNotebookForLLM(payload.content), [], skills))
      }

      const lineNumbers = success.includeLineNumbers ?? formattingOptions.enableLineNumbers ?? false
      const lineStep = sparse ? READ_LINE_NUMBER_INTERVAL : formattingOptions.sparseLineNumbers
      const formatted = formatCodeBlock({
        content: payload.content,
        filePath: success.path,
        startLineNumber: success.readRange?.startLine ?? 1,
        totalLineNumbersInFile: success.totalLines ?? 0,
        formattingOptions: {
          ...formattingOptions,
          enableLineNumbers: lineNumbers,
          ...(lineStep === undefined ? {} : { sparseLineNumbers: lineStep }),
        },
      }, {
        addAmountOfOmittedLines: success.readRange !== undefined &&
          (success.readRange.startLine > 1 || success.readRange.endLine < (success.totalLines ?? 0)),
      })
      return createStringResult(addReminders(formatted, success.relatedRules ?? [], skills))
    },
  }
}
