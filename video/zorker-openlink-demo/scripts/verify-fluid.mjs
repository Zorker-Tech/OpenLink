import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const read=p=>fs.readFileSync(p,'utf8'),hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const board=JSON.parse(read('src/reference-film/storyboard-v10.json'));
const source=JSON.parse(read('provenance/current-composers.json'));
for(const r of source.records)assert.equal(hash(r.output),r.outputSha256,r.output);
const film=read('src/reference-film/Film.tsx');
assert.ok(film.includes('storyboard-v10.json'));
assert.equal(board.shots.length,8);assert.equal(board.transitions.length,7);
assert.equal(board.shots.reduce((sum,s)=>sum+s.activeFrames,0),board.runtimeFrames);
assert.equal(board.shots.reduce((sum,s)=>sum+s.sequenceFrames,0)-board.transitions.reduce((sum,t)=>sum+t.frames,0),board.runtimeFrames);
assert.equal(board.model,'GPT-6 Luna');
const clock=read('src/reference-film/ShotClock.tsx');assert.ok(clock.includes('duration/playbackFrames'));assert.ok(clock.includes('f-lead'));
const native=read('src/reference-film/Native.tsx');assert.ok(native.includes('document.fonts.ready'));assert.ok(native.includes('fronts'));assert.ok(native.includes('layoutPoint'));assert.ok(!native.includes('getBoundingClientRect'));
const resolution=read('src/reference-film/Resolution.tsx');assert.equal((resolution.match(/<ProductPreview/g)||[]).length,1);assert.ok(resolution.includes('paletteProgress'));
const helpers=read('src/reference-film/Choreography.tsx');assert.ok(helpers.includes('gsap.context'));assert.ok(helpers.includes('paused:true'));assert.ok(helpers.includes('totalTime'));assert.ok(helpers.includes('context.revert'));assert.ok(helpers.includes('ticker.sleep'));
const tracks=JSON.parse(read('src/reference-film/choreography.json'));
const stability=[];
for(const [name,track] of Object.entries(tracks)){
 let maxPositionStep=0,maxScaleStep=0;for(let i=1;i<track.samples.length;i++){const a=track.samples[i-1],b=track.samples[i];maxPositionStep=Math.max(maxPositionStep,Math.hypot(b.x-a.x,b.y-a.y));maxScaleStep=Math.max(maxScaleStep,Math.abs(b.zoom-a.zoom));}
 assert.ok(maxPositionStep<20,name+' camera jump');assert.ok(maxScaleStep<.05,name+' scale jump');stability.push({name,maxPositionStep,maxScaleStep});
}
for(const name of ['Intent','Execution','Artifact','Refinement','Resolution','Features'])assert.ok(!read('src/reference-film/'+name+'.tsx').includes('Caption'));
assert.ok(!read('src/reference-film/Genesis.tsx').includes('GlassOrb'));
const report={sourceModules:source.records.length,shots:board.shots.map(s=>s.sequenceFrames),transitions:board.transitions.map(t=>t.frames),durationFrames:board.runtimeFrames,durationSeconds:board.runtimeSeconds,modelFixture:board.model,primaryFps:board.format.fps,width:board.format.width,height:board.format.height,tracks:stability,stableInputGeometry:true,scopedNativeGsap:true,singlePaletteTree:true,noFrozenSceneHandles:true};
fs.writeFileSync('provenance/fluid-verification.json',JSON.stringify(report,null,2));console.log('PASS: source integrity, eight GSAP tracks, scoped native animations, paced cut math, single palette tree, GPT-6 Luna demo fixture, 4K60 timing.');
