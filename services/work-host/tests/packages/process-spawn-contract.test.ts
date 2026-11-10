import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { of } from "rxjs"

import { spawn, spawnPromise, type OutputChunk } from "../../source/packages/utils/process-spawn.ts"

test("stdin values reach the child and source completion closes stdin", async () => {
  const output = await spawnPromise(
    process.execPath,
    ["-e", "process.stdin.setEncoding('utf8');let text='';process.stdin.on('data',chunk=>text+=chunk);process.stdin.on('end',()=>process.stdout.write(text))"],
    { stdin: of("one", " two"), timeout: 1_000 },
  )
  assert.equal(output, "one two")
})

test("split spawn streams identify stdout and stderr chunks", async () => {
  const chunks: OutputChunk[] = []
  await new Promise<void>((resolve, reject) => {
    spawn(process.execPath, ["-e", "process.stdout.write('out');process.stderr.write('err')"], { split: true }).subscribe({
      next: chunk => chunks.push(chunk),
      error: reject,
      complete: resolve,
    })
  })
  assert.deepEqual(chunks.map(chunk => [chunk.source, chunk.text]).sort(), [["stderr", "err"], ["stdout", "out"]])
})

test("retry repeats a started command after a nonzero exit and retains output from each attempt", async t => {
  const directory = await mkdtemp(join(tmpdir(), "slate-spawn-retry-"))
  t.after(async () => await rm(directory, { recursive: true, force: true }))
  const counter = join(directory, "attempts.txt")
  const script = "const fs=require('node:fs');let n=0;try{n=Number(fs.readFileSync(process.argv[1],'utf8'))}catch{};fs.writeFileSync(process.argv[1],String(n+1));console.log('attempt-'+(n+1));process.exit(n===0?1:0)"

  const output = await spawnPromise(process.execPath, ["-e", script, counter], { retries: 1, retryDelay: 5 })
  assert.equal(output.trim(), "attempt-1\nattempt-2")
  assert.equal(await readFile(counter, "utf8"), "2")
})
