import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as mod from '../../source/shared/local-exec-daemon.ts';
describe('the local-exec daemon files', () => {
  it('are the platform JSON files, named by what they carry, with the supervised window', () => {
    assert.equal(mod.LOCAL_EXEC_DAEMON_CONNECTION_FILENAME, 'local-exec-daemon-connection.json');
    assert.equal(mod.LOCAL_EXEC_DAEMON_DISCOVERY_FILENAME, 'local-exec-daemon.json');
    assert.equal(mod.LOCAL_EXEC_DAEMON_CREDENTIAL_FILENAME, 'local-exec-daemon-credential.json');
    assert.equal(mod.LOCAL_EXEC_SUPERVISOR_HEARTBEAT_FILENAME, 'local-exec-supervisor.json');
    assert.equal(mod.SLATE_LOCAL_EXEC_SUPERVISED_WINDOW_MS, 90_000);
    assert.deepEqual(Object.keys(mod).sort(), ['LOCAL_EXEC_DAEMON_CONNECTION_FILENAME', 'LOCAL_EXEC_DAEMON_CREDENTIAL_FILENAME', 'LOCAL_EXEC_DAEMON_DISCOVERY_FILENAME', 'LOCAL_EXEC_SUPERVISOR_HEARTBEAT_FILENAME', 'SLATE_LOCAL_EXEC_SUPERVISED_WINDOW_MS']);
  });
});
