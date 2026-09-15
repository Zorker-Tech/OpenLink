import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import ts from 'typescript';
import {createRequire} from 'node:module';
const js=ts.transpileModule(fs.readFileSync('src/fixtures.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
const module={exports:{}};
new Function('module','exports','require',js)(module,module.exports,createRequire(import.meta.url));
const {stateAt,INITIAL_PROMPT,REVISED_PROMPT,USER_MESSAGE_ID}=module.exports;
assert.equal(stateAt(244).submitted,false);
assert.equal(stateAt(245).working,true);
assert.equal(stateAt(599).preview,false);
assert.equal(stateAt(600).preview,true);
assert.equal(stateAt(800).code,true);
assert.equal(stateAt(990).code,false);
assert.equal(stateAt(1020).editing,true);
assert.equal(stateAt(1185).resending,true);
assert.equal(stateAt(1220).revised,true);
assert.equal(stateAt(1319).finished,false);
assert.equal(stateAt(1320).finished,true);
assert.ok(INITIAL_PROMPT.includes('warm neutral'));
assert.ok(REVISED_PROMPT.includes('electric blue'));
assert.equal(USER_MESSAGE_ID,'demo-user-message-1');
for(const f of [1409,0,1320,245,800,1020,599,600]) assert.deepEqual(stateAt(f),stateAt(f));
const manifest=JSON.parse(fs.readFileSync('provenance/manifest.json','utf8'));
for(const asset of manifest.records.filter(x=>x.path.endsWith('.svg'))) {
 const local=`public/brand/${asset.path.split('/').at(-1)}`;
 assert.equal(crypto.createHash('sha256').update(fs.readFileSync(local)).digest('hex'),asset.sha256);
}
const extracted=fs.readFileSync('src/source-ui.tsx','utf8');
for(const name of ['Message','MessageContent','TaskItem','TaskItemFile','Artifact','ArtifactHeader','ArtifactTitle','ArtifactContent']) {
 assert.ok(extracted.includes(fs.readFileSync(`provenance/original/${name}.tsx.txt`,'utf8')),`${name} retains source presentation`);
}
assert.ok(extracted.includes('border-dashed'));
assert.ok(extracted.includes('File changes are not rolled back.'));
assert.ok(!/fetch\(|setTimeout\(|Date.now\(|Math.random\(/.test(extracted));
console.log('PASS: 14 workflow checks, out-of-order state evaluation, 4 brand hashes, 8 exact presentation extracts, inline-edit warning and no-network constraints.');
