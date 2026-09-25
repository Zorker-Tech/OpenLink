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

export interface TextResult {
  content: Array<{ type: "text"; text: string }>
  isError: boolean
}

export interface ImageResult {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>
  isError: boolean
}

export function createStringResult(content: string, isError = false): TextResult {
  return { content: [{ type: "text", text: content }], isError }
}

/** An image result may carry a line of text before it, which is what tells the model what it is looking at. */
export function createImageResult(
  imageData: string,
  mimeType: string,
  textContent?: string,
  isError = false,
): ImageResult {
  const content: ImageResult["content"] = []
  if (textContent) content.push({ type: "text", text: textContent })
  content.push({ type: "image", data: imageData, mimeType })
  return { content, isError }
}

export class OutputTokensLimitExceededError extends Error {
  constructor(message = "Provider exceeded max output tokens") {
    super(message)
    this.name = "OutputTokensLimitExceededError"
  }
}

export class InputTokenLimitError extends Error {
  constructor(message = "Input token limit exceeded") {
    super(message)
    this.name = "InputTokenLimitError"
  }
}

export class ProactiveSummarizationThresholdError extends Error {
  constructor(message = "Configured summarization threshold reached") {
    super(message)
    this.name = "ProactiveSummarizationThresholdError"
  }
}
