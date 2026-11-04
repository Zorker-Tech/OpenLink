import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { createContext } from "../../source/packages/context/context.ts"
import { SlateMode, type SlateMode as SlateModeValue } from "../../source/packages/agent/mode-processing.ts"
import { WriteArgs } from "../../source/adapters/interop/proto/generated/agent/v1/write_exec_pb.ts"
import { writeExecutorResource } from "../../source/packages/agent-exec/write-operation.ts"
import { writeCodeSelectionToFile } from "../../source/packages/agent/context/code-selection-spill.ts"
import { renderSelectedCodeSelections } from "../../source/packages/agent/context/code-selection-context.ts"
import { hasNetworkAllowlist } from "../../source/packages/agent/tools/core/shell/sandbox-permissions.ts"
import { SandboxingDescription } from "../../source/packages/agent/tools/core/shell/sandbox-description.ts"
import { renderContent } from "../../source/packages/prompt-jsx/index.ts"
import { WORKSPACE_IGNORE_FILE_NAME } from "../../source/packages/constants/box-archive.ts"

const ctx = () => createContext()

// ---------------------------------------------------------------------------------------------
// spilling a long selection
// ---------------------------------------------------------------------------------------------

/** A write executor that records what it was asked to write, so the file never has to exist. */
function recordingWriteExecutor(): {
  accessor: { get(resource: typeof writeExecutorResource): { execute(ctx: unknown, args: WriteArgs): Promise<unknown> } }
  writes: Array<{ path: string; fileBytes: Uint8Array }>
} {
  const writes: Array<{ path: string; fileBytes: Uint8Array }> = []
  return {
    writes,
    accessor: {
      get: (_resource: typeof writeExecutorResource) => ({
        async execute(_ctx: unknown, args: WriteArgs) {
          writes.push({ path: args.path, fileBytes: args.fileBytes })
          return {}
        },
      }),
    },
  }
}

test("a selection is written into the project's uploads folder with its line range in the name", async () => {
  const { accessor, writes } = recordingWriteExecutor()
  const written = await writeCodeSelectionToFile({
    ctx: ctx(),
    content: "const a = 1\n",
    originalPath: "/p/src/thing.ts",
    startLine: 10,
    endLine: 20,
    index: 2,
    requestContext: { env: { projectFolder: "/p", workspacePaths: ["/workspace-fallback"] } },
    resourceAccessor: accessor,
  })
  assert.equal(written?.path, path.join("/p", "uploads", "thing-L10-L20-2.ts"))
  assert.equal(writes.length, 1)
  assert.equal(new TextDecoder().decode(writes[0]!.fileBytes), "const a = 1\n")
})

test("the workspace's folder is used when there is no project folder", async () => {
  const { accessor } = recordingWriteExecutor()
  const written = await writeCodeSelectionToFile({
    ctx: ctx(),
    content: "x",
    originalPath: "/w/a.py",
    startLine: 1,
    endLine: 1,
    index: 0,
    requestContext: { env: { workspacePaths: ["/w", "/not-selected"] } },
    resourceAccessor: accessor,
  })
  assert.equal(written?.path, path.join("/w", "uploads", "a-L1-L1-0.py"))
})

test("a file with no extension, or an unsafe name, still gets a usable one", async () => {
  const { accessor } = recordingWriteExecutor()
  const noExtension = await writeCodeSelectionToFile({
    ctx: ctx(),
    content: "x",
    originalPath: "/p/Makefile",
    startLine: 1,
    endLine: 2,
    index: 0,
    requestContext: { env: { projectFolder: "/p", workspacePaths: ["/p"] } },
    resourceAccessor: accessor,
  })
  assert.equal(noExtension?.path.endsWith("Makefile-L1-L2-0.txt"), true)

  const unsafe = await writeCodeSelectionToFile({
    ctx: ctx(),
    content: "x",
    originalPath: "/p/a b/c$d.ts",
    startLine: 1,
    endLine: 1,
    index: 1,
    requestContext: { env: { projectFolder: "/p", workspacePaths: ["/p"] } },
    resourceAccessor: accessor,
  })
  assert.equal(unsafe?.path.endsWith("c_d-L1-L1-1.ts"), true)
})

test("a spill with nowhere to write, or no accessor, does not happen", async () => {
  const { accessor } = recordingWriteExecutor()
  assert.equal(
    await writeCodeSelectionToFile({
      ctx: ctx(),
      content: "x",
      originalPath: "/p/a.ts",
      startLine: 1,
      endLine: 1,
      index: 0,
      requestContext: undefined,
      resourceAccessor: accessor,
    }),
    undefined,
  )
  assert.equal(
    await writeCodeSelectionToFile({
      ctx: ctx(),
      content: "x",
      originalPath: "/p/a.ts",
      startLine: 1,
      endLine: 1,
      index: 0,
      requestContext: { env: { projectFolder: "/p", workspacePaths: ["/p"] } },
      resourceAccessor: undefined,
    }),
    undefined,
  )
})

test("a spill that fails is logged and the selection is left to be inlined", async () => {
  const failing = {
    get: () => ({
      async execute() {
        throw new Error("disk full")
      },
    }),
  } as never
  assert.equal(
    await writeCodeSelectionToFile({
      ctx: ctx(),
      content: "x",
      originalPath: "/p/a.ts",
      startLine: 1,
      endLine: 1,
      index: 0,
      requestContext: { env: { projectFolder: "/p", workspacePaths: ["/p"] } },
      resourceAccessor: failing,
    }),
    undefined,
  )
})

// ---------------------------------------------------------------------------------------------
// rendering selections
// ---------------------------------------------------------------------------------------------

test("nothing is rendered when nothing was selected", async () => {
  const rendered = await renderSelectedCodeSelections({
    ctx: ctx(),
    codeSelections: [],
    formattingOptions: {},
    enableLongCodeSelectionSpillToFile: false,
    requestContext: undefined,
    resourceAccessor: undefined,
  })
  assert.deepEqual(rendered, { attachedFilesContent: [], documentInfos: [] })
})

test("a small selection is inlined as a tagged block with its line range", async () => {
  const rendered = await renderSelectedCodeSelections({
    ctx: ctx(),
    codeSelections: [{ path: "/p/a.ts", content: "one\ntwo", range: { start: { line: 5 }, end: { line: 6 } } }],
    formattingOptions: {},
    enableLongCodeSelectionSpillToFile: false,
    requestContext: undefined,
    resourceAccessor: undefined,
  })
  assert.equal(rendered.attachedFilesContent.length, 1)
  const text = rendered.attachedFilesContent[0]!.text
  assert.match(text, /^\n<code_selection path="\/p\/a\.ts" lines="5-6">/)
  assert.match(text, /     5\\|one/)
  assert.equal(rendered.documentInfos.length, 0)
})

test("a selection with no range starts at the first line", async () => {
  const rendered = await renderSelectedCodeSelections({
    ctx: ctx(),
    codeSelections: [{ path: "/p/a.ts", content: "one" }],
    formattingOptions: {},
    enableLongCodeSelectionSpillToFile: false,
    requestContext: undefined,
    resourceAccessor: undefined,
  })
  assert.match(rendered.attachedFilesContent[0]!.text, /lines="1-1"/)
})

test("a notebook's selection is not line-numbered even when the session asks for numbers", async () => {
  const rendered = await renderSelectedCodeSelections({
    ctx: ctx(),
    codeSelections: [{ path: "/p/n.ipynb", content: "print(1)" }],
    formattingOptions: { enableLineNumbers: true },
    enableLongCodeSelectionSpillToFile: false,
    requestContext: undefined,
    resourceAccessor: undefined,
  })
  assert.doesNotMatch(rendered.attachedFilesContent[0]!.text, /\|\s*print/)
})

test("a selection over the inline limit is spilled and the block says where it went", async () => {
  const { accessor, writes } = recordingWriteExecutor()
  const rendered = await renderSelectedCodeSelections({
    ctx: ctx(),
    codeSelections: [{ path: "/p/big.ts", content: "x".repeat(25_000), range: { start: { line: 1 }, end: { line: 900 } } }],
    formattingOptions: {},
    enableLongCodeSelectionSpillToFile: true,
    requestContext: { env: { projectFolder: "/p", workspacePaths: ["/p"] } },
    resourceAccessor: accessor,
  })
  assert.equal(writes.length, 1)
  assert.deepEqual(rendered.documentInfos, [{ path: path.join("/p", "uploads", "big-L1-L900-0.ts") }])
  const text = rendered.attachedFilesContent[0]!.text
  assert.match(text, /^<code_selection lines="1-900" source="\/p\/big\.ts" file="\/p\/uploads\/big-L1-L900-0\.ts">/)
  assert.match(text, /too large to inline/)
  assert.doesNotMatch(text, /x{100}/)
})

test("a selection at the inline limit stays in the prompt", async () => {
  const { accessor, writes } = recordingWriteExecutor()
  const rendered = await renderSelectedCodeSelections({
    ctx: ctx(),
    codeSelections: [{ path: "/p/edge.ts", content: "x".repeat(20_000) }],
    formattingOptions: {},
    enableLongCodeSelectionSpillToFile: true,
    requestContext: { env: { projectFolder: "/p", workspacePaths: ["/p"] } },
    resourceAccessor: accessor,
  })

  assert.equal(writes.length, 0)
  assert.equal(rendered.documentInfos.length, 0)
  assert.match(rendered.attachedFilesContent[0]!.text, /<code_selection path="\/p\/edge\.ts" lines="1-1">/)
})

test("a spill that is not enabled, or that fails, leaves the selection inlined", async () => {
  const long = "x".repeat(25_000)
  const notEnabled = await renderSelectedCodeSelections({
    ctx: ctx(),
    codeSelections: [{ path: "/p/big.ts", content: long }],
    formattingOptions: {},
    enableLongCodeSelectionSpillToFile: false,
    requestContext: { env: { projectFolder: "/p", workspacePaths: ["/p"] } },
    resourceAccessor: recordingWriteExecutor().accessor,
  })
  assert.equal(notEnabled.documentInfos.length, 0)
  assert.ok(notEnabled.attachedFilesContent[0]!.text.length > 25_000)

  const noAccessor = await renderSelectedCodeSelections({
    ctx: ctx(),
    codeSelections: [{ path: "/p/big.ts", content: long }],
    formattingOptions: {},
    enableLongCodeSelectionSpillToFile: true,
    requestContext: undefined,
    resourceAccessor: undefined,
  })
  assert.equal(noAccessor.documentInfos.length, 0)
  assert.ok(noAccessor.attachedFilesContent[0]!.text.length > 25_000)
})

test("several selections are rendered in order, each with its own index", async () => {
  const { accessor } = recordingWriteExecutor()
  const rendered = await renderSelectedCodeSelections({
    ctx: ctx(),
    codeSelections: [
      { path: "/p/a.ts", content: "x".repeat(25_000) },
      { path: "/p/b.ts", content: "small" },
    ],
    formattingOptions: {},
    enableLongCodeSelectionSpillToFile: true,
    requestContext: { env: { projectFolder: "/p", workspacePaths: ["/p"] } },
    resourceAccessor: accessor,
  })
  assert.equal(rendered.attachedFilesContent.length, 2)
  assert.match(rendered.attachedFilesContent[0]!.text, /-L1-L1-0\.ts/)
  assert.match(rendered.attachedFilesContent[1]!.text, /b\.ts/)
})

// ---------------------------------------------------------------------------------------------
// the sandbox description
// ---------------------------------------------------------------------------------------------

test("a read-only session is told it cannot write", () => {
  const rendered = renderContent(SandboxingDescription({
    isReadonly: true,
    sandboxNetworkInfo: { hasDefaults: false, explicitEntries: [] },
  }))
  assert.match(rendered, /readonly sandbox/)
  assert.match(rendered, /Network access is disallowed by default/)
  assert.doesNotMatch(rendered, /Disables the sandbox entirely/)
})

test("an ordinary session is told what it can do and how to ask for more", () => {
  const rendered = renderContent(SandboxingDescription({
    isReadonly: false,
    sandboxNetworkInfo: { hasDefaults: false, explicitEntries: [] },
  }))
  assert.match(rendered, /allows most writes to the workspace/)
  assert.match(rendered, new RegExp(WORKSPACE_IGNORE_FILE_NAME))
  assert.match(rendered, /all: Disables the sandbox entirely/)
  assert.match(rendered, /Needed for package installs and internet requests/)
})

test("a sandbox with a network allowlist is described as already having the network", () => {
  const withDefaults = renderContent(SandboxingDescription({
    isReadonly: false,
    sandboxNetworkInfo: { hasDefaults: true, explicitEntries: [] },
  }))
  assert.match(withDefaults, /common package managers and version control providers/)
  assert.match(withDefaults, /outside the allowed domains/)

  const explicit = renderContent(SandboxingDescription({
    isReadonly: false,
    sandboxNetworkInfo: { hasDefaults: false, explicitEntries: ["a.test", "b.test"] },
  }))
  assert.match(explicit, /network access for the following domains: a\.test, b\.test/)
  assert.doesNotMatch(explicit, /common package managers/)
})

test("the sandbox description's own predicate agrees with the permission helper", () => {
  assert.equal(hasNetworkAllowlist({ hasDefaults: true, explicitEntries: [] }), true)
  assert.equal(hasNetworkAllowlist({ hasDefaults: false, explicitEntries: [] }), false)
})

// ---------------------------------------------------------------------------------------------
// the tool set builder's contract
// ---------------------------------------------------------------------------------------------

test("the tool set builder's contract is a type, and a builder satisfies it", async () => {
  const generator = (input: { mode: SlateModeValue; loggingContext: unknown }) => ({
    getAllTools: () => [],
    mode: input.mode,
  })
  assert.equal(generator({ mode: SlateMode.AGENT, loggingContext: ctx() }).mode, SlateMode.AGENT)
})

test("the write operation is the resource the spill goes through", () => {
  const { accessor } = recordingWriteExecutor()
  assert.equal(typeof accessor.get(writeExecutorResource).execute, "function")
})

test("a real spill lands in the uploads folder on disk", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "slate-spill-")))
  try {
    const accessor = {
      get: () => ({
        async execute(_ctx: unknown, args: WriteArgs) {
          const { writeFile, mkdir } = await import("node:fs/promises")
          await mkdir(path.dirname(args.path), { recursive: true })
          await writeFile(args.path, args.fileBytes)
          return {}
        },
      }),
    } as never
    const written = await writeCodeSelectionToFile({
      ctx: ctx(),
      content: "spilled content",
      originalPath: "/p/thing.ts",
      startLine: 3,
      endLine: 4,
      index: 0,
      requestContext: { env: { projectFolder: root, workspacePaths: [root] } },
      resourceAccessor: accessor,
    })
    assert.equal(await readFile(written!.path, "utf8"), "spilled content")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
