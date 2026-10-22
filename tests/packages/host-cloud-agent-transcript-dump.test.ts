import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as mod from '../../source/host/cloud-agents/cloud-agent-transcript-dump.ts';

const dumpAnswer = (answer: unknown) => ({ async getTranscriptDump(): Promise<{ status: string; lineCount: number; jsonl: string } | null> { return answer as { status: string; lineCount: number; jsonl: string } | null; } });

describe('dumping a cloud agent transcript', () => {
  it('names one file per agent, and dumps it unless the transcript is empty', async () => {
    assert.equal(mod.cloudAgentTranscriptDumpPath('bc-1'), 'cloud-agent-transcripts/bc-1.jsonl');
    const writes: string[][] = [];
    const writer = async (path: string, data: Uint8Array): Promise<unknown> => { writes.push([path, Buffer.from(data).toString('utf8')]); return undefined; };
    assert.equal(await mod.dumpCloudAgentTranscript({ api: dumpAnswer(null), writeBoxFile: writer, bcId: 'bc-1' }), null);
    const empty = await mod.dumpCloudAgentTranscript({ api: dumpAnswer({ status: 'ok', lineCount: 0, jsonl: '' }), writeBoxFile: writer, bcId: 'bc-1' });
    assert.deepEqual(empty, { status: 'ok', lineCount: 0 });
    assert.deepEqual(writes, [], 'an empty transcript is not written');
    const dumped = await mod.dumpCloudAgentTranscript({ api: dumpAnswer({ status: 'ok', lineCount: 2, jsonl: 'a\nb' }), writeBoxFile: writer, bcId: 'bc-7' });
    assert.deepEqual(dumped, { status: 'ok', lineCount: 2, file: { path: 'cloud-agent-transcripts/bc-7.jsonl', sizeBytes: 3 } });
    assert.deepEqual(writes, [['cloud-agent-transcripts/bc-7.jsonl', 'a\nb']]);
  });
  it('says where the file is and how to read its end', () => {
    assert.equal(mod.formatCloudAgentDumpCompletionLine({ path: 'p/x.jsonl', sizeBytes: 10 }, 2), 'Full transcript dumped to p/x.jsonl (10 bytes, 2 message lines). Read it with your shell tools; `tail -n 1 p/x.jsonl` gives the final assistant report.');
  });
  it('appends its line to a watch result, and leaves the result alone when it cannot', async () => {
    const result = { text: 'the text' };
    const appended = await mod.augmentWatchResultWithTranscriptDump({ api: dumpAnswer({ status: 'ok', lineCount: 1, jsonl: 'x' }), writeBoxFile: async () => undefined, bcId: 'bc-1', result });
    assert.equal(appended.text.startsWith('the text'), true);
    assert.equal(appended.text.includes('Full transcript dumped to cloud-agent-transcripts/bc-1.jsonl'), true);
    const failedApi = await mod.augmentWatchResultWithTranscriptDump({ api: { async getTranscriptDump(): Promise<never> { throw new Error('api'); } }, writeBoxFile: async () => undefined, bcId: 'bc-1', result });
    assert.equal(failedApi, result, 'a failure leaves the caller its own result');
    const noDump = await mod.augmentWatchResultWithTranscriptDump({ api: dumpAnswer(null), writeBoxFile: async () => undefined, bcId: 'bc-1', result });
    assert.equal(noDump, result);
  });
});
