import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as ordering from '../../source/shared/ordering.ts';
import { ORDERED_REPLICAS_V1, ROSTER_REPLICA_KEY, transcriptReplicaKey } from '../../source/shared/ordering.ts';
describe('the keys replicas are ordered by', () => {
  it('names the version, the roster and one agent transcript', () => {
    assert.equal(ORDERED_REPLICAS_V1, 'orderedReplicasV1');
    assert.equal(ROSTER_REPLICA_KEY, 'roster');
    assert.equal(transcriptReplicaKey('agent-1'), 'transcript:agent-1');
    assert.equal(transcriptReplicaKey(''), 'transcript:');
    assert.equal(transcriptReplicaKey('代理'), 'transcript:代理');
    assert.deepEqual(Object.keys(ordering).sort(), ['ORDERED_REPLICAS_V1', 'ROSTER_REPLICA_KEY', 'transcriptReplicaKey']);
  });
});
