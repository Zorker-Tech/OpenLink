import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const execute = promisify(execFile)

test('sets explicit environment values without a platform shell', async () => {
  const script = fileURLToPath(new URL('../run-with-env.mjs', import.meta.url))
  const result = await execute(process.execPath, [script, 'OPENLINK_TEST_VALUE=native host', '--', 'node', '-e', 'process.stdout.write(process.env.OPENLINK_TEST_VALUE)'])
  assert.equal(result.stdout, 'native host')
})

test('rejects malformed assignments before starting a child', async () => {
  const script = fileURLToPath(new URL('../run-with-env.mjs', import.meta.url))
  await assert.rejects(() => execute(process.execPath, [script, 'NOT-VALID=x', '--', 'node', '-e', 'process.exit(0)']), /Invalid environment variable name/)
})
