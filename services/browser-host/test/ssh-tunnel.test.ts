import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSshLocalForwardArgs } from '../src/ssh-tunnel.js'

test('SSH forwarding binds locally and reaches only target loopback', () => {
  const args = buildSshLocalForwardArgs({
    target: { host: 'server.example.com', user: 'openlink', port: 2222, knownHostsFile: '/tmp/known_hosts', identityFile: '/tmp/id_ed25519' },
    remotePort: 9222,
  }, 43199)
  assert.deepEqual(args.slice(-5), ['-i', '/tmp/id_ed25519', '-L', '127.0.0.1:43199:127.0.0.1:9222', 'openlink@server.example.com'])
  assert.ok(args.includes('StrictHostKeyChecking=yes'))
  assert.ok(args.includes('ExitOnForwardFailure=yes'))
})

test('SSH forwarding rejects command-shaped host input', () => {
  assert.throws(() => buildSshLocalForwardArgs({
    target: { host: '-oProxyCommand=evil', user: 'openlink', port: 22, knownHostsFile: '/tmp/known_hosts' }, remotePort: 3000,
  }, 43199), /unsafe characters/)
})
