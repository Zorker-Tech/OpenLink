import { test } from "node:test"
import assert from "node:assert/strict"

import {
  createGenerateImageTool,
  createImageGenerationConcurrencyLimiter,
  type GenerateImageService,
  type ImageGenerationConcurrencyLimiter,
} from "../../source/packages/agent/tools/core/generate-image.ts"
import { createContext, type Context } from "../../source/packages/context/context.ts"
import { PrivacyMode } from "../../source/packages/redaction/privacy-mode.ts"
import { ASK_MODE_MODEL_ERROR } from "../../source/packages/agent/tools/tool-support.ts"
import { ToolCallRejectedError, ToolErrorClassification } from "../../source/packages/agent/tools/tool-errors.ts"
import { GenerateImageResult } from "../../source/packages/proto/generated/agent/v1/generate_image_tool_pb.ts"
import { ReadResult, ReadSuccess } from "../../source/packages/proto/generated/agent/v1/read_exec_pb.ts"
import { WriteResult, WriteSuccess } from "../../source/packages/proto/generated/agent/v1/write_exec_pb.ts"
import { readExecutorResource } from "../../source/packages/agent-exec/read-operation.ts"
import { writeExecutorResource } from "../../source/packages/agent-exec/write-operation.ts"

// ---------------------------------------------------------------------------------------------
// a tool built over fake executors, so the provider and the filesystem are both scripted
// ---------------------------------------------------------------------------------------------

/** A 2x2 PNG, small enough that the render path leaves it as it is. */
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg=="

interface Harness {
  readonly writes: Array<{ path: string; bytes: Uint8Array }>
  readonly reads: Array<{ path: string; toolCallId?: string }>
  readonly generated: Array<{ description: string; filename?: string; referenceCount: number; aspectRatio?: string }>
  readonly resourceAccessor: unknown
  readonly tool: Record<string, unknown>
  readonly limiterEvents: string[]
}

function harness(options: {
  write?: WriteResult
  read?: ReadResult
  generate?: () => Promise<{ filePath: string; imageData: string; usage?: unknown }>
  requestContext?: { env?: { projectFolder?: string; artifactsFolder?: string; workspacePaths?: readonly string[] } }
  promptVersion?: string
  isReadonly?: boolean
  isModelRestricted?: boolean
  suspiciousKeywords?: readonly string[]
  limiter?: ImageGenerationConcurrencyLimiter
} = {}): Harness {
  const writes: Harness["writes"] = []
  const reads: Harness["reads"] = []
  const generated: Harness["generated"] = []
  const limiterEvents: string[] = []

  const readExecutor = {
    async execute(_ctx: Context, args: { path: string; toolCallId?: string }) {
      reads.push({ path: args.path, ...(args.toolCallId === undefined ? {} : { toolCallId: args.toolCallId }) })
      return options.read ?? new ReadResult({ result: { case: "success", value: new ReadSuccess({ path: args.path, totalLines: 0, fileSize: 0n, output: { case: "data", value: new Uint8Array([1, 2, 3]) } }) } })
    },
  }
  const writeExecutor = {
    async execute(_ctx: Context, args: { path: string; fileBytes: Uint8Array }) {
      writes.push({ path: args.path, bytes: args.fileBytes })
      return options.write ?? new WriteResult({ result: { case: "success", value: new WriteSuccess({ path: args.path }) } })
    },
  }
  const resourceAccessor = {
    get: (resource: unknown) => resource === readExecutorResource ? readExecutor : writeExecutor,
  }
  const generateImageService: GenerateImageService = async (_ctx, description, filename, references, aspectRatio) => {
    generated.push({
      description,
      ...(filename === undefined ? {} : { filename }),
      referenceCount: references?.length ?? 0,
      ...(aspectRatio === undefined ? {} : { aspectRatio }),
    })
    // The provider names the file it produced; the tool keeps that name, since that is the image's own.
    return await (options.generate ?? (async () => ({ filePath: `/tmp/${filename ?? "generated.png"}`, imageData: `data:image/png;base64,${TINY_PNG_BASE64}` })))()
  }
  const limiter = options.limiter ?? {
    async acquire() { limiterEvents.push("acquire") },
    release() { limiterEvents.push("release") },
  }

  const tool = createGenerateImageTool({
    resourceAccessor: resourceAccessor as never,
    generateImageService,
    ...(options.promptVersion === undefined ? {} : { promptVersion: options.promptVersion }),
    ...(options.requestContext === undefined ? {} : { requestContext: options.requestContext }),
    imageGenerationConcurrencyLimiter: limiter,
    ...(options.isReadonly === undefined ? {} : { isReadonly: options.isReadonly }),
    ...(options.suspiciousKeywords === undefined ? {} : { suspiciousKeywords: options.suspiciousKeywords }),
    ...(options.isModelRestricted === undefined ? {} : { isModelRestricted: options.isModelRestricted }),
  })
  return { writes, reads, generated, resourceAccessor, tool, limiterEvents }
}

interface ToolLike {
  name: string
  descriptionGenerator(): string
  parameters: { jsonSchema?: { properties?: Record<string, unknown>; required?: string[] } }
  execute(ctx: Context, handler: unknown, argsStream: AsyncIterable<string>, meta: Record<string, unknown>): Promise<GenerateImageResult>
  render(ctx: Context, result: GenerateImageResult, props?: unknown): Promise<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError: boolean }>
}

const asTool = (tool: Record<string, unknown>): ToolLike => tool as unknown as ToolLike

async function* argsOf(args: unknown): AsyncIterable<string> {
  yield JSON.stringify(args)
}

const fakeHandler = (): {
  emitPartialToolCall(ctx: Context, toolCallId: string, call: unknown): void
  executeToolCall(ctx: Context, call: unknown, id: string, run: (ctx: Context) => Promise<GenerateImageResult>, merge: (result: GenerateImageResult) => unknown): Promise<GenerateImageResult>
} => ({
  emitPartialToolCall() {},
  async executeToolCall(ctx, _call, _id, run, merge) {
    const result = await run(ctx)
    merge(result)
    return result
  },
})

const run = (tool: ToolLike, args: unknown, meta: Record<string, unknown> = {}, ctx: Context = createContext()) =>
  tool.execute(ctx, fakeHandler(), argsOf(args), { toolCallId: "call-1", ...meta })

const textOf = (result: { content: Array<{ type: string; text?: string }> }): string =>
  result.content.map(part => part.text ?? "").join("")

// ---------------------------------------------------------------------------------------------
// the tool as the model sees it
// ---------------------------------------------------------------------------------------------

test("the tool is named the way each prompt version expects", () => {
  assert.equal(asTool(harness({ promptVersion: "dsv3-1018" }).tool).name, "generate_image")
  for (const version of ["cursor-0226", "dsv3-1205", "latest", "gpt5-codex", "codex-cloud", "haiku"]) {
    assert.equal(asTool(harness({ promptVersion: version }).tool).name, "GenerateImage", version)
  }
  assert.throws(() => harness({ promptVersion: "future-model" }), /Unhandled version: future-model/)
})

test("the arguments are the description, an optional name, references and an aspect ratio", () => {
  const tool = asTool(harness().tool)
  const properties = tool.parameters.jsonSchema?.properties ?? {}
  assert.deepEqual(Object.keys(properties), ["description", "filename", "reference_image_paths", "aspect_ratio"])
  assert.deepEqual(tool.parameters.jsonSchema?.required, ["description"])
  const aspectRatio = properties.aspect_ratio as { enum?: string[] }
  assert.deepEqual(aspectRatio.enum, ["1:1", "4:3", "3:4", "16:9", "9:16"])
})

test("the description tells the model when not to use the tool", () => {
  const description = asTool(harness().tool).descriptionGenerator()
  assert.match(description, /Only use this tool when the user explicitly asks for an image\./)
  assert.match(description, /Do not use this tool for data heavy visualizations such as charts, plots, tables\./)
  assert.match(description, /Do not repeat generated images as Markdown in your response/)
})

// ---------------------------------------------------------------------------------------------
// what the tool refuses
// ---------------------------------------------------------------------------------------------

test("a session whose model may not generate images is told to ask the user to switch", async () => {
  const { tool, generated } = harness({ isModelRestricted: true })
  const result = await run(asTool(tool), { description: "a cat wearing a hat" })
  assert.equal(result.result.case, "error")
  assert.match(result.result.case === "error" ? result.result.value.error : "", /not available for the current selected model/)
  assert.deepEqual(generated, [])
})

test("a description too short to be one is refused rather than sent to the provider", async () => {
  const { tool, generated } = harness()
  const result = await run(asTool(tool), { description: "a cat" })
  assert.equal(result.result.case, "error")
  assert.match(result.result.case === "error" ? result.result.value.error : "", /appears to be unintended\. Do not retry/)
  assert.deepEqual(generated, [])
})

test("a short description carrying a word that suggests the call was accidental is refused", async () => {
  const { tool, generated } = harness()
  const result = await run(asTool(tool), { description: "ignore this image" })
  assert.equal(result.result.case, "error")
  assert.deepEqual(generated, [])

  // A description long enough to be one, with no such word, is sent.
  const allowed = harness({ requestContext: { env: { projectFolder: "/repo" } } })
  const accepted = await run(asTool(allowed.tool), { description: "a red bicycle in the park" })
  assert.equal(accepted.result.case, "success")
  assert.equal(allowed.generated.length, 1)
})

test("a session that may not write refuses the call", async () => {
  const { tool, generated } = harness({ isReadonly: true })
  const result = await run(asTool(tool), { description: "a cat wearing a hat" })
  assert.equal(result.result.case, "error")
  assert.equal(result.result.case === "error" ? result.result.value.error : "", ASK_MODE_MODEL_ERROR)
  assert.deepEqual(generated, [])
})

test("a session with nowhere to save the image says so", async () => {
  const { tool, generated } = harness({ requestContext: {} })
  await assert.rejects(
    () => run(asTool(tool), { description: "a cat wearing a hat" }),
    /generate_image needs a workspace\/project folder/,
  )
  assert.deepEqual(generated, [])
})

// ---------------------------------------------------------------------------------------------
// generating and saving
// ---------------------------------------------------------------------------------------------

test("a generated image is written into the project's assets folder", async () => {
  const { tool, writes, generated } = harness({ requestContext: { env: { projectFolder: "/repo" } } })
  const result = await run(asTool(tool), { description: "a cat wearing a hat", filename: "cat.png" })
  assert.equal(result.result.case, "success")
  if (result.result.case !== "success") return
  assert.equal(result.result.value.filePath, "/repo/assets/cat.png")
  assert.equal(writes.length, 1)
  assert.equal(writes[0]?.path, "/repo/assets/cat.png")
  assert.deepEqual(generated[0], { description: "a cat wearing a hat", filename: "cat.png", referenceCount: 0 })
  // The bytes written are the image the provider returned, without its data-uri prefix.
  assert.equal(Buffer.from(writes[0]?.bytes ?? new Uint8Array()).toString("base64"), TINY_PNG_BASE64)
})

test("a run with an artifacts folder saves there, and hands back no inline image", async () => {
  const { tool, writes } = harness({ requestContext: { env: { projectFolder: "/repo", artifactsFolder: "/artifacts" } } })
  const result = await run(asTool(tool), { description: "a cat wearing a hat", filename: "cat.png" })
  if (result.result.case !== "success") throw new Error("expected a success")
  assert.equal(result.result.value.filePath, "/artifacts/assets/cat.png")
  assert.equal(result.result.value.imageData, "")
  assert.equal(writes[0]?.path, "/artifacts/assets/cat.png")
})

test("a filename that arrives as a path is reduced to its last part", async () => {
  const { tool, writes } = harness({ requestContext: { env: { projectFolder: "/repo" } } })
  await run(asTool(tool), { description: "a cat wearing a hat", filename: "/tmp/elsewhere/cat.png" })
  assert.equal(writes[0]?.path, "/repo/assets/cat.png")
})

test("the workspace root is used when there is no project folder", async () => {
  const { tool, writes } = harness({ requestContext: { env: { workspacePaths: ["/work"] } } })
  await run(asTool(tool), { description: "a cat wearing a hat", filename: "cat.png" })
  assert.equal(writes[0]?.path, "/work/assets/cat.png")
})

test("the aspect ratio and the reference images reach the provider", async () => {
  const { tool, generated, reads } = harness({ requestContext: { env: { projectFolder: "/repo" } } })
  await run(asTool(tool), {
    description: "a cat wearing a hat",
    aspect_ratio: "16:9",
    reference_image_paths: ["/repo/one.png", "/repo/two.jpg"],
  })
  assert.equal(generated[0]?.aspectRatio, "16:9")
  assert.equal(generated[0]?.referenceCount, 2)
  assert.deepEqual(reads.map(read => read.path), ["/repo/one.png", "/repo/two.jpg"])
  // The read is made under the tool call, so a failure to read can be traced back to it.
  assert.equal(reads[0]?.toolCallId, "call-1")
})

test("a reference image that cannot be read is left out rather than failing the call", async () => {
  const { tool, generated } = harness({
    requestContext: { env: { projectFolder: "/repo" } },
    read: new ReadResult({ result: { case: "fileNotFound", value: {} } as never }),
  })
  const result = await run(asTool(tool), { description: "a cat wearing a hat", reference_image_paths: ["/repo/missing.png"] })
  assert.equal(result.result.case, "success")
  assert.equal(generated[0]?.referenceCount, 0)
})

test("the provider is only asked for one image at a time beyond the limit", async () => {
  const limiter = createImageGenerationConcurrencyLimiter(1)
  const order: string[] = []
  const { tool } = harness({
    requestContext: { env: { projectFolder: "/repo" } },
    limiter: {
      async acquire() { order.push("acquire"); await limiter.acquire() },
      release() { order.push("release"); limiter.release() },
    },
  })
  await run(asTool(tool), { description: "a cat wearing a hat" })
  assert.deepEqual(order, ["acquire", "release"])
})

test("the concurrency limiter refuses a limit that is not a positive number", () => {
  assert.throws(() => createImageGenerationConcurrencyLimiter(0), /maxConcurrent must be a finite number >= 1/)
  assert.throws(() => createImageGenerationConcurrencyLimiter(Number.NaN), /maxConcurrent must be a finite number >= 1/)
})

test("the limiter lets the configured number through and queues the rest", async () => {
  const limiter = createImageGenerationConcurrencyLimiter(2)
  const admitted: number[] = []
  await limiter.acquire()
  await limiter.acquire()
  let third = false
  const pending = limiter.acquire().then(() => { third = true })
  await Promise.resolve()
  assert.equal(third, false)
  admitted.push(1)
  limiter.release()
  await pending
  assert.equal(third, true)
  assert.deepEqual(admitted, [1])
})

// ---------------------------------------------------------------------------------------------
// when the write does not work
// ---------------------------------------------------------------------------------------------

test("a write refused because the session is read-only is reported as such", async () => {
  const { tool } = harness({
    requestContext: { env: { projectFolder: "/repo" } },
    write: new WriteResult({ result: { case: "permissionDenied", value: { operation: "write", isReadonly: true, error: "no" } } as never }),
  })
  const result = await run(asTool(tool), { description: "a cat wearing a hat" })
  assert.equal(result.result.case, "error")
  assert.equal(result.result.case === "error" ? result.result.value.error : "", ASK_MODE_MODEL_ERROR)
})

test("a write that fails for another reason is thrown with what the workspace said", async () => {
  const cases: Array<{ write: WriteResult; expected: RegExp; isRejected?: boolean }> = [
    {
      write: new WriteResult({ result: { case: "error", value: { error: "the disk is full" } } as never }),
      expected: /Failed to save generated image: the disk is full/,
    },
    {
      write: new WriteResult({ result: { case: "permissionDenied", value: { operation: "write", isReadonly: false, error: "denied" } } as never }),
      expected: /permission denied \(operation=write, isReadonly=false, error=denied\)/,
    },
    {
      write: new WriteResult({ result: { case: "rejected", value: { reason: "the user said no" } } as never }),
      expected: /Failed to save generated image: rejected \(reason=the user said no\)/,
      isRejected: true,
    },
    {
      write: new WriteResult({ result: { case: "noSpace", value: {} } as never }),
      expected: /Failed to save generated image: No space left on device/,
    },
  ]
  for (const entry of cases) {
    const { tool } = harness({ requestContext: { env: { projectFolder: "/repo" } }, write: entry.write })
    await assert.rejects(
      () => run(asTool(tool), { description: "a cat wearing a hat" }),
      (error: Error) => entry.expected.test(error.message),
      `expected ${entry.expected}`,
    )
    if (entry.isRejected === true) {
      await assert.rejects(
        () => run(asTool(harness({ requestContext: { env: { projectFolder: "/repo" } }, write: entry.write }).tool), { description: "a cat wearing a hat" }),
        ToolCallRejectedError,
      )
    }
  }
})

test("a rejection caused by a missing tool call context is not reported as the user refusing", async () => {
  const { tool } = harness({
    requestContext: { env: { projectFolder: "/repo" } },
    write: new WriteResult({ result: { case: "rejected", value: { reason: "Failed to find tool call context for the write" } } as never }),
  })
  await assert.rejects(
    () => run(asTool(tool), { description: "a cat wearing a hat" }),
    (error: Error) => error.constructor === Error && /Failed to save generated image/.test(error.message),
  )
})

// ---------------------------------------------------------------------------------------------
// what the provider said, when it said no
// ---------------------------------------------------------------------------------------------

test("a provider rejection carries the status and the error it nested in its own body", async () => {
  const providerError = Object.assign(new Error("Image generation request failed"), {
    response: {
      status: 500,
      statusText: "Internal Server Error",
      data: {
        error: {
          message: "the provider refused",
          provider: { body: JSON.stringify({ error: { code: "upstream_error", message: "the model is unavailable" } }) },
        },
      },
    },
  })
  const { tool } = harness({
    requestContext: { env: { projectFolder: "/repo" } },
    generate: async () => { throw providerError },
  })
  await assert.rejects(
    () => run(asTool(tool), { description: "a cat wearing a hat" }),
    (error: Error & { classification?: string }) =>
      error.classification === ToolErrorClassification.PROVIDER_ERROR &&
      error.message.includes("status=500 Internal Server Error") &&
      error.message.includes("upstream_error"),
  )
})

test("a provider rejection with a bad-request status is classified as invalid arguments", async () => {
  const providerError = Object.assign(new Error("Image generation request failed"), {
    response: { status: 400, statusText: "Bad Request", data: { error: { message: "the prompt is too long" } } },
  })
  const { tool } = harness({
    requestContext: { env: { projectFolder: "/repo" } },
    generate: async () => { throw providerError },
  })
  await assert.rejects(
    () => run(asTool(tool), { description: "a cat wearing a hat" }),
    (error: Error & { classification?: string }) => error.classification === ToolErrorClassification.INVALID_ARGS,
  )
})

test("a content-safety refusal is reported as a safety block rather than as a provider error", async () => {
  const safetyError = Object.assign(new Error("blocked"), { name: "ImageGenerationContentSafetyError" })
  const { tool } = harness({
    requestContext: { env: { projectFolder: "/repo" } },
    generate: async () => { throw safetyError },
  })
  await assert.rejects(
    () => run(asTool(tool), { description: "a cat wearing a hat" }),
    (error: Error & { classification?: string }) =>
      error.classification === ToolErrorClassification.INVALID_ARGS &&
      error.message === "The image generation was blocked due to content safety policies.",
  )
})

test("a moderation block nested inside the provider's response counts as a safety refusal", async () => {
  const nested = Object.assign(new Error("blocked"), {
    response: { data: { error: { provider: { body: JSON.stringify({ error: { code: "moderation_blocked" } }) } } } },
  })
  const wrapped = Object.assign(new Error("wrapped"), { cause: nested })
  const { tool } = harness({
    requestContext: { env: { projectFolder: "/repo" } },
    generate: async () => { throw wrapped },
  })
  await assert.rejects(
    () => run(asTool(tool), { description: "a cat wearing a hat" }),
    /blocked due to content safety policies/,
  )
})

// ---------------------------------------------------------------------------------------------
// what the model is shown
// ---------------------------------------------------------------------------------------------

test("an image saved into the artifacts folder is referred to by an image tag", async () => {
  const { tool } = harness({ requestContext: { env: { projectFolder: "/repo", artifactsFolder: "/artifacts" } } })
  const result = await run(asTool(tool), { description: "a cat wearing a hat", filename: "cat.png" })
  const rendered = await asTool(tool).render(createContext(), result)
  assert.equal(rendered.isError, false)
  assert.match(textOf(rendered), /<img src="\/artifacts\/assets\/cat\.png" alt="Generated image" \/>/)
})

test("the versions that read a path are given the path rather than the image", async () => {
  const { tool } = harness({ requestContext: { env: { projectFolder: "/repo" } }, promptVersion: "dsv3-1018" })
  const result = await run(asTool(tool), { description: "a cat wearing a hat", filename: "cat.png" })
  const rendered = await asTool(tool).render(createContext(), result)
  assert.match(textOf(rendered), /Successfully generated image at: \/repo\/assets\/cat\.png/)
  assert.match(textOf(rendered), /Do not repeat this image as a Markdown reference/)
  assert.equal(rendered.content.some(part => part.type === "image"), false)
})

test("every other version is given the image itself", async () => {
  const { tool } = harness({ requestContext: { env: { projectFolder: "/repo" } } })
  const result = await run(asTool(tool), { description: "a cat wearing a hat", filename: "cat.png" })
  const rendered = await asTool(tool).render(createContext(), result)
  const image = rendered.content.find(part => part.type === "image")
  assert.equal(image?.mimeType, "image/png")
  assert.equal(image?.data, TINY_PNG_BASE64)
  assert.match(textOf(rendered), /Successfully generated image at: \/repo\/assets\/cat\.png/)
})

test("a success with no image data is reported rather than rendered as an empty image", async () => {
  const { tool } = harness({
    requestContext: { env: { projectFolder: "/repo" } },
    generate: async () => ({ filePath: "/tmp/generated.png", imageData: "" }),
  })
  const result = await run(asTool(tool), { description: "a cat wearing a hat" })
  const rendered = await asTool(tool).render(createContext(), result)
  assert.equal(textOf(rendered), "Failed to generate image: no image data returned")
})

test("a refusal is rendered as the sentence the model is shown", async () => {
  const { tool } = harness({ isReadonly: true })
  const result = await run(asTool(tool), { description: "a cat wearing a hat" })
  assert.equal(textOf(await asTool(tool).render(createContext(), result)), ASK_MODE_MODEL_ERROR)
})

test("an error is rendered with its message", async () => {
  const { tool } = harness({ isModelRestricted: true })
  const result = await run(asTool(tool), { description: "a cat wearing a hat" })
  assert.match(textOf(await asTool(tool).render(createContext(), result)), /^Failed to generate image, error: /)
})

// ---------------------------------------------------------------------------------------------
// the turn's usage
// ---------------------------------------------------------------------------------------------

test("what the provider reported about usage is added to the turn", async () => {
  const usage: unknown[] = []
  const { tool } = harness({
    requestContext: { env: { projectFolder: "/repo" } },
    generate: async () => ({ filePath: "/tmp/generated.png", imageData: TINY_PNG_BASE64, usage: { imageCount: 1 } }),
  })
  await run(asTool(tool), { description: "a cat wearing a hat" }, { stateHandler: { addTurnUsage: (value: unknown) => usage.push(value) } })
  assert.deepEqual(usage, [{ imageCount: 1 }])
})

test("the privacy mode of the session is used when writing", async () => {
  const { tool } = harness({ requestContext: { env: { projectFolder: "/repo" } } })
  const result = await run(asTool(tool), { description: "a cat wearing a hat" }, { stateHandler: { getPrivacyMode: () => PrivacyMode.NO_STORAGE } })
  assert.equal(result.result.case, "success")
})
