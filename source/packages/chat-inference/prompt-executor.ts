/**
 * The small things every prompt executor hands back.
 *
 * A tool's result reaches the model as content parts, and the two shapes that matter are text and an
 * image with the text that explains it — so the constructors here are what a tool uses instead of
 * assembling the array itself. The three errors are the limits a prompt can hit: the provider's own output
 * cap, the input side of the same limit, and the point at which the platform decides to summarize before
 * the provider refuses. They are distinct types because the three are handled differently — one is the
 * model's problem, one is the conversation's, and one is the platform's own policy.
 */

/** A line of text a tool result carries. */
interface TextPart { type: "text"; text: string }

/** An image a tool result carries, with the media type that says how to read it. */
interface ImagePart { type: "image"; data: string; mimeType: string }

export interface TextResult {
  content: TextPart[]
  isError: boolean
}

export interface ImageResult {
  content: Array<TextPart | ImagePart>
  isError: boolean
}

/** A text part, built the one way the model reads it. */
function textPart(text: string): TextPart { return { type: "text", text } }

/** An image part, built the one way the model reads it. */
function imagePart(data: string, mimeType: string): ImagePart { return { type: "image", data, mimeType } }

export function createStringResult(content: string, isError = false): TextResult {
  return { content: [textPart(content)], isError }
}

/** An image result may carry a line of text before it, which is what tells the model what it is looking at. */
export function createImageResult(
  imageData: string,
  mimeType: string,
  textContent?: string,
  isError = false,
): ImageResult {
  const content: ImageResult["content"] = []
  if (textContent) content.push(textPart(textContent))
  content.push(imagePart(imageData, mimeType))
  return { content, isError }
}

/** The messages the three limits read as when nothing more specific is known. */
const OUTPUT_TOKENS_LIMIT_MESSAGE = "Provider exceeded max output tokens"
const INPUT_TOKEN_LIMIT_MESSAGE = "Input token limit exceeded"
const PROACTIVE_SUMMARIZATION_THRESHOLD_MESSAGE = "Configured summarization threshold reached"

export class OutputTokensLimitExceededError extends Error {
  override name = "OutputTokensLimitExceededError"
  constructor(message = OUTPUT_TOKENS_LIMIT_MESSAGE) { super(message) }
}

export class InputTokenLimitError extends Error {
  override name = "InputTokenLimitError"
  constructor(message = INPUT_TOKEN_LIMIT_MESSAGE) { super(message) }
}

export class ProactiveSummarizationThresholdError extends Error {
  override name = "ProactiveSummarizationThresholdError"
  constructor(message = PROACTIVE_SUMMARIZATION_THRESHOLD_MESSAGE) { super(message) }
}
