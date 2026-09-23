import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const read=p=>fs.readFileSync(p,'utf8');
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const board=JSON.parse(read('src/reference-film/storyboard-v10.json'));
const sourceRoot=path.resolve('../..');
const faithful=JSON.parse(read('provenance/faithful-manifest.json'));
let verified=0;
for(const record of faithful.records)if(record.outputSha256){assert.equal(hash(record.output),record.outputSha256,record.output);verified++;}

const film=read('src/reference-film/Film.tsx');
assert.equal(board.shots.length,8);assert.equal(board.transitions.length,7);
assert.equal(board.shots.reduce((sum,s)=>sum+s.activeFrames,0),board.runtimeFrames);
assert.equal(board.shots.reduce((sum,s)=>sum+s.sequenceFrames,0)-board.transitions.reduce((sum,t)=>sum+t.frames,0),board.runtimeFrames);
assert.ok(film.includes('storyboard-v10.json'));
assert.ok(film.includes("background:'#ffffff'"));
assert.ok(film.includes('audio/openlink-keyboard-sfx.wav'));
assert.ok(board.audio.music===false&&board.model==='GPT-6 Luna');

for(const name of ['Intent','Execution','Artifact','Refinement','Resolution','Features']){
 const scene=read(`src/reference-film/${name}.tsx`);
 assert.ok(!scene.includes('Caption'),`Overhead title is prohibited: ${name}`);
 assert.ok(!scene.includes('What do you want to build?'),`Intro copy is prohibited: ${name}`);
}

const product=read('src/reference-film/ProductPreview.tsx');
for(const item of ['SourceTopbar','SourceChatTopbar','NativeTimeline','CurrentSessionComposer','SourcePreviewCanvas'])assert.ok(product.includes(item),item);
assert.ok(product.includes('width:390'),'Latest chat column is 390px');
assert.ok(product.includes('height={742}'),'Timeline uses the measured default session-workspace viewport');
const native=read('src/reference-film/Native.tsx');
assert.ok(native.includes("'./source/timeline.js'"));
assert.ok(native.includes('FilmTimelineUi'));
assert.ok(read('src/reference-film/source/timeline.js').includes("?? 'GPT-6 Luna'"));
for(const file of ['film-home-composer.js','film-chat-composer.js'])assert.ok(read(`src/reference-film/current-ui/components/${file}`).includes("name: 'GPT-6 Luna'"),file);

const preview=JSON.parse(read('provenance/reference-preview-extraction.json'));
for(const record of preview.outputs)assert.equal(hash(record.path),record.sha256,record.path);
for(const record of preview.sourceFiles){
 if(['components/chat-workspace.tsx','components/chat-timeline.tsx','components/browser/browser-workbench.tsx','components/browser/chromium-stream-surface.tsx'].includes(record.path))
  assert.equal(hash(path.join(sourceRoot,record.path)),record.sha256,record.path);
}
const previewModule=read('src/reference-film/source/preview.js');
for(const symbol of ['SourceChatTopbar','SourceTopbar','BrowserNavigationBar','SourcePreviewCanvas'])assert.ok(previewModule.includes(symbol),symbol);
assert.ok(!/fetch\(|WebSocket|BrowserRuntimeClient/.test(previewModule),'No live runtime/network adapters in extracted film UI');
assert.equal(preview.noBusinessLogicWrites,true);
assert.equal(preview.modelFixture.name,'GPT-6 Luna');assert.equal(preview.modelFixture.liveProviderCall,false);

const filmReport=JSON.parse(read('provenance/reference-film.json'));
assert.equal(filmReport.liveExecution,false);
assert.equal(filmReport.audio.music,false);
assert.deepEqual([filmReport.composition.width,filmReport.composition.height,filmReport.composition.fps,filmReport.composition.durationInFrames],[board.format.width,board.format.height,board.format.fps,board.runtimeFrames]);
assert.equal(filmReport.modelFixture.name,'GPT-6 Luna');assert.equal(filmReport.modelFixture.liveProviderCall,false);

const audio=JSON.parse(read('provenance/keyboard-sfx-audio.json'));
assert.equal(audio.music,false);
assert.ok(Math.abs(audio.duration-board.runtimeFrames/board.format.fps)<1e-9);
assert.ok(audio.keyboardCues>0);
assert.equal(audio.clippedSamples,0);
assert.deepEqual(audio.finalSamples,[0,0]);
const keyCues=audio.cues.filter(c=>c.type==='typing');assert.equal(keyCues.length,audio.keyboardCues);
assert.ok(keyCues.every(c=>Math.abs(c.at*board.format.fps-c.frame)<1e-8));
console.log(`PASS: ${verified} frozen extraction records; current session layout and composers; source/output hashes; 8-shot director's cut = ${board.runtimeSeconds}s at 4K60; GPT-6 Luna demo fixture; no overhead titles; SFX-only mix.`);
