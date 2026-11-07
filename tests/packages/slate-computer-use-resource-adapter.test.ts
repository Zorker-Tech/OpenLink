import assert from "node:assert/strict"
import { test } from "node:test"

import { computerUseExecutorResource } from "../../source/adapters/interop/agent/computer-use-executor-adapter.ts"
import { createContext } from "../../source/packages/context/context.ts"
import {
  ComputerUseAction,
  ComputerUseArgs,
  ComputerUseError,
  ComputerUseResult,
  ComputerUseSuccess,
  Coordinate,
  ClickAction,
  MouseButton,
  ScreenshotAction,
} from "../../source/adapters/interop/proto/generated/agent/v1/computer_use_tool_pb.ts"
import { ExecClientMessage, ExecServerMessage } from "../../source/adapters/interop/proto/generated/agent/v1/exec_pb.ts"
import type {
  SlateComputerUseExecutorRequest,
  SlateComputerUseExecutorResult,
} from "../../source/packages/agent/conversation-step-state.ts"

const slateRequest: SlateComputerUseExecutorRequest = {
  toolCallId: "call-1",
  description: "inspect the menu",
  bindUnmappedCharacters: true,
  actions: [
    { kind: "click", coordinate: { x: 12, y: 5 }, button: "right", count: 2, modifierKeys: "CTRL" },
    { kind: "screenshot" },
  ],
}

test("the resource exposes Slate requests while isolating the generated remote message", async () => {
  const context = createContext()
  let sentMessage: ExecServerMessage | undefined
  const generatedResult = new ComputerUseResult({ result: {
    case: "success",
    value: new ComputerUseSuccess({
      actionCount: 2,
      durationMs: 18,
      screenshot: "image-data",
      log: "completed",
      screenshotPath: "/tmp/capture.webp",
      cursorPosition: new Coordinate({ x: 20, y: 21 }),
    }),
  } })
  const manager = {
    async *createExecInstance(_context: unknown, encode: (id: number) => ExecServerMessage) {
      sentMessage = encode(17)
      yield new ExecClientMessage({
        id: 17,
        message: { case: "computerUseResult", value: generatedResult },
      })
    },
  }
  const executor = computerUseExecutorResource.remoteImplementation(manager)
  const result = await executor.execute(context, slateRequest)

  assert.equal(sentMessage?.message.case, "computerUseArgs")
  if (sentMessage?.message.case !== "computerUseArgs") assert.fail("expected a generated executor request at the adapter")
  const args = sentMessage.message.value
  assert.equal(args.toolCallId, "call-1")
  assert.equal(args.description, "inspect the menu")
  assert.equal(args.bindUnmappedCharacters, true)
  assert.equal(args.actions[0]?.action.case, "click")
  if (args.actions[0]?.action.case !== "click") assert.fail("expected the click action")
  assert.deepEqual([args.actions[0].action.value.button, args.actions[0].action.value.count], [MouseButton.RIGHT, 2])
  assert.deepEqual(result, {
    kind: "success",
    actionCount: 2,
    durationMs: 18,
    screenshot: "image-data",
    log: "completed",
    screenshotPath: "/tmp/capture.webp",
    cursorPosition: { x: 20, y: 21 },
  })
})

test("the controlled side receives Slate actions and returns a Slate error through the adapter", async () => {
  const context = createContext()
  let handledRequest: SlateComputerUseExecutorRequest | undefined
  let registeredHandler: { handle(ctx: unknown, request: ExecServerMessage): AsyncIterable<ExecClientMessage> | undefined } | undefined
  const slateResult: SlateComputerUseExecutorResult = {
    kind: "error",
    message: "desktop is unavailable",
    actionCount: 1,
    durationMs: 7,
    log: "connection lost",
    screenshot: "partial-image",
    screenshotPath: "/tmp/partial.webp",
  }
  computerUseExecutorResource.registerControlledImplementation({
    async execute(_ctx, request) {
      handledRequest = request
      return slateResult
    },
  }, {
    register(handler) {
      registeredHandler = handler as typeof registeredHandler
    },
  })

  const generatedRequest = new ExecServerMessage({
    id: 5,
    message: { case: "computerUseArgs", value: new ComputerUseArgs({
      toolCallId: "legacy-call",
      description: "click the menu",
      actions: [
        new ComputerUseAction({ action: {
          case: "click",
          value: new ClickAction({ coordinate: new Coordinate({ x: 4, y: 9 }), button: MouseButton.LEFT, count: 1 }),
        } }),
        new ComputerUseAction({ action: { case: "screenshot", value: new ScreenshotAction() } }),
      ],
    }) },
  })
  const stream = registeredHandler?.handle(context, generatedRequest)
  if (stream === undefined) assert.fail("expected the resource to register its handler")
  const responses: ExecClientMessage[] = []
  for await (const response of stream) responses.push(response)

  assert.deepEqual(handledRequest, {
    toolCallId: "legacy-call",
    description: "click the menu",
    actions: [
      { kind: "click", coordinate: { x: 4, y: 9 }, button: "left", count: 1 },
      { kind: "screenshot" },
    ],
  })
  const resultMessage = responses.find(response => response.message.case === "computerUseResult")
  assert.equal(resultMessage?.message.case, "computerUseResult")
  if (resultMessage?.message.case !== "computerUseResult") assert.fail("expected the generated result at the adapter")
  const decodedResult = resultMessage.message.value
  assert.equal(decodedResult.result.case, "error")
  if (decodedResult.result.case !== "error") assert.fail("expected an error outcome")
  assert.deepEqual(decodedResult.result.value, new ComputerUseError({
    error: "desktop is unavailable",
    actionCount: 1,
    durationMs: 7,
    log: "connection lost",
    screenshot: "partial-image",
    screenshotPath: "/tmp/partial.webp",
  }))
})
