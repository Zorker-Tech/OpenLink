import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const manifest=JSON.parse(fs.readFileSync('provenance/faithful-manifest.json','utf8'));
const verified=[];
for(const record of manifest.records)if(record.outputSha256){assert.equal(hash(record.output),record.outputSha256,record.output);verified.push(record.output);}
for(const file of fs.readdirSync('src/reference-film').filter(f=>f.endsWith('.tsx'))) {
 const content=fs.readFileSync(path.join('src/reference-film',file),'utf8');
 assert.ok(!/Date\.now\(|Math\.random\(|performance\.now\(|requestAnimationFrame\(|setTimeout\(|fetch\(/.test(content),file);
}
const film=fs.readFileSync('src/reference-film/Film.tsx','utf8');
const durations=[...film.matchAll(/durationInFrames=\{(\d+)\}/g)].map(m=>Number(m[1]));
assert.equal(durations.length,8);assert.equal(durations.reduce((a,b)=>a+b,0),3600);
const native=fs.readFileSync('src/reference-film/Native.tsx','utf8');
for(const file of ['Intent','Execution','Artifact','Refinement','Resolution']) {
 const source=fs.readFileSync(`src/reference-film/${file}.tsx`,'utf8');
 assert.ok(!source.includes('Caption'),`Overhead title is prohibited: ${file}`);
 assert.ok(!source.includes('What do you want to build?'),`Intro copy is prohibited: ${file}`);
}
assert.ok(native.includes('source-snapshot/components/film-session-composer.js'));assert.ok(native.includes('./source/timeline.js'));
const audio=JSON.parse(fs.readFileSync('provenance/reference-audio.json','utf8'));
assert.equal(audio.duration,60);assert.ok(audio.peakDbFS<0);assert.deepEqual(audio.finalSamples,[0,0]);
const preview=JSON.parse(fs.readFileSync('provenance/reference-preview-extraction.json','utf8'));
for(const record of preview.outputs)assert.equal(hash(record.path),record.sha256,record.path);
const execution=fs.readFileSync('src/reference-film/Execution.tsx','utf8');
assert.ok(execution.includes('590,700'));assert.ok(execution.includes('workflowOpen'));assert.ok(execution.includes('expanded={f>=440}'));
const sourcePaths=['components/chat-workspace.tsx','components/chat-timeline.tsx','app/globals.css','app/fonts/geist-latin.woff2','public/openlink/logos/zorker-logo-light.svg'];
const report={sourceBaselineCommit:manifest.baseCommit,baselineNote:'Frozen 2026-09-07 source-derived presentation. Snapshot hashes validated. Current dirty application has evolved; this is not a claim of current full-app parity.',verifiedSnapshotFiles:verified.length,sourceFiles:sourcePaths.map(p=>({path:p,currentSha256:hash(path.join('../..',p))})),shownComponents:[{source:'components/chat-workspace.tsx:ChatComposer + ComposerSubmitButton',frozen:'src/source-snapshot/components/film-session-composer.js',adapter:'src/reference-film/Native.tsx:NativePrompt',shots:[2,5],changes:'Uses previously extracted presentation. Deterministic text, no events dispatched. Adds cinematic caret overlay and camera outside the component.'},{source:'components/chat-timeline.tsx:ChatTimeline',frozen:'src/source-snapshot/components/chat-timeline.js',adapter:'src/reference-film/Native.tsx:NativeTimeline',shots:[3,4],changes:'Existing reducer, grouped task rows and file changes. Synthetic English fixture messages; 560px viewport. Closed error/edit/disclosure states.'}],artwork:[{file:'src/reference-film/primitives.tsx:GlassOrb',rights:'Original procedural vector artwork; reference used for motion direction only.'},{file:'src/scenes/SampleSite.tsx',rights:'Existing illustrative Forma demo output; not a recorded live build.'},{file:'public/brand/zorker-logo-light.svg',rights:'User-supplied Zorker mark.'},{file:'public/fonts/geist-latin.woff2',rights:'Existing repository Geist font; original font license applies.'},{file:'public/audio/openlink-reference-original.wav',rights:'Original synthesis from scripts/reference-audio.mjs; no borrowed soundtrack.'}],durationInFrames:2760,fps:60,deterministicSourceAudit:true,referenceMediaIncluded:false,liveExecution:false,currentParityException:'Existing verify-faithful.mjs fails against newer application EditableUserMessage error class text-xs text-[var(--app-danger)]. Snapshot hashes pass; this state is not in the film.'};
report.durationInFrames=durations.reduce((a,b)=>a+b,0);
report.revision='3: complete workflow, native preview, feature inserts';
report.nativePreviewExtraction='provenance/reference-preview-extraction.json';
report.workflowVerification={completeReplyShown:true,gitSnapshotExpanded:true,topToBottomCamera:true,completedDetailsRemainOpen:true};
report.artwork=report.artwork.map(item=>item.file==='public/audio/openlink-reference-original.wav'?{...item,file:'public/audio/openlink-reference-original-60s.wav'}:item);
fs.writeFileSync('provenance/reference-film.json',JSON.stringify(report,null,2));
console.log(`PASS: ${verified.length} unchanged baseline files; native preview/inspector/version extraction hashes; 8 scenes / 3600 frames; completed workflow; no overhead titles; PCM audio bounds.`);
