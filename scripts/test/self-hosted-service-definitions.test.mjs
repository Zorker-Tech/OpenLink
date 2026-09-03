import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../../', import.meta.url)

test('systemd unit runs only the active prebuilt release with hardened state paths', async () => {
  const source = await readFile(new URL('deploy/self-hosted/systemd/openlink.service', root), 'utf8')
  assert.match(source, /^User=openlink$/m)
  assert.match(source, /^ExecStart=\/opt\/openlink\/current\/bin\/openlinkctl run /m)
  assert.match(source, /^Restart=on-failure$/m)
  assert.match(source, /^TimeoutStopSec=180$/m)
  assert.match(source, /^UMask=0077$/m)
  assert.match(source, /^ProtectSystem=strict$/m)
  assert.match(source, /^NoNewPrivileges=true$/m)
  assert.doesNotMatch(source, /(password|secret|token)=/i)
  assert.doesNotMatch(source, /(?:npm|pnpm|yarn|next|tsc|go|docker|podman) (?:install|build|pull)/i)
})

test('launchd service runs only the active prebuilt release and embeds no credentials', async () => {
  const source = await readFile(new URL('deploy/self-hosted/launchd/io.zokerbase.openlink.plist', root), 'utf8')
  assert.match(source, /<string>\/Library\/Application Support\/OpenLink\/current\/bin\/openlinkctl<\/string>/)
  assert.match(source, /<string>run<\/string>/)
  assert.match(source, /<key>KeepAlive<\/key>/)
  assert.match(source, /<string>openlink<\/string>/)
  assert.doesNotMatch(source, /(password|secret|token)<\/key>/i)
})

test('edge publishes Web and scoped gateway routes but no privileged service port', async () => {
  const source = await readFile(new URL('deploy/self-hosted/edge/Caddyfile', root), 'utf8')
  assert.match(source, /reverse_proxy 127\.0\.0\.1:3000/)
  assert.match(source, /reverse_proxy 127\.0\.0\.1:43121/)
  assert.doesNotMatch(source, /127\.0\.0\.1:(?:43120|43123|43124|54380|19530|9091)/)
  assert.match(source, /Strict-Transport-Security/)
})

