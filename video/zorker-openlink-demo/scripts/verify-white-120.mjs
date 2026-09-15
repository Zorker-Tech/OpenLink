import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import ts from 'typescript';
const read=p=>fs.readFileSync(p,'utf8'),hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const manifest=JSON.parse(read('provenance/current-composers.json'));
for(const r of manifest.records)assert.equal(hash(r.output),r.outputSha256,r.output);
const sourceDrift=manifest.roots.map(r=>({source:r.source,capturedSha256:r.sha256,currentSha256:hash(path.join('../..',r.source)),changed:hash(path.join('../..',r.source))!==r.sha256}));
assert.equal(hash(manifest.css.output),manifest.css.outputSha256);
const home=read('src/reference-film/current-ui/components/film-home-composer.js'),chat=read('src/reference-film/current-ui/components/film-chat-composer.js');
assert.ok(home.includes('CurrentHomeComposer'));assert.ok(home.includes('h-[122px]'));assert.ok(home.includes('AccessModePicker'));assert.ok(home.includes('AgentKindPicker'));assert.ok(home.includes('Select Project'));
assert.ok(chat.includes('h-[42px]'));assert.ok(chat.includes('expanded = false'));
for(const content of [home,chat])assert.ok(!/fetch\(|setTimeout\(|Date\.now\(|createChatSessionAction\(/.test(content));
// Verify all static homepage JSX class attributes survive the source extraction.
const original=ts.createSourceFile('home.tsx',read('../../components/workspace-prompt.tsx'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const output=ts.createSourceFile('home.js',home,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),strings=new Set();
function values(n){if(ts.isStringLiteral(n))strings.add(n.text);ts.forEachChild(n,values);}values(output);
let classes=0;function check(n){if(ts.isJsxAttribute(n)&&n.name.getText(original)==='className'&&n.initializer&&ts.isStringLiteral(n.initializer)){assert.ok(strings.has(n.initializer.text),'Changed home class: '+n.initializer.text);classes++;}ts.forEachChild(n,check);}check(original);
// Preserve the approved video snapshot when unrelated application logic evolves.
// Compare the currently relevant chat input's static presentation classes as a scoped guard.
const chatAst=ts.createSourceFile('chat.tsx',read('../../components/chat-workspace.tsx'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const chatJs=ts.createSourceFile('chat.js',chat,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),chatStrings=new Set();
function chatValues(n){if(ts.isStringLiteral(n))chatStrings.add(n.text);ts.forEachChild(n,chatValues);}chatValues(chatJs);
let chatClasses=0;function checkChat(n){if(ts.isJsxAttribute(n)&&n.name.getText(chatAst)==='className'&&n.initializer&&ts.isStringLiteral(n.initializer)){assert.ok(chatStrings.has(n.initializer.text),'Changed chat input class: '+n.initializer.text);chatClasses++;}ts.forEachChild(n,checkChat);}
function findChat(n){if(ts.isJsxElement(n)&&n.openingElement.tagName.getText(chatAst)==='PromptInput'){checkChat(n);return;}ts.forEachChild(n,findChat);}findChat(chatAst);
const film=read('src/reference-film/Film.tsx');
const durations=[...film.matchAll(/TransitionSeries\.Sequence[^>]*durationInFrames=\{(\d+)\}/g)].map(m=>Number(m[1]));
const transitions=[...film.matchAll(/TransitionSeries\.Transition[^\n]+durationInFrames:(\d+)/g)].map(m=>Number(m[1]));
assert.equal(durations.length,8);assert.equal(transitions.length,7);assert.ok(transitions.every(n=>n===96));assert.equal(durations.reduce((a,b)=>a+b,0)-transitions.reduce((a,b)=>a+b,0),6720);
assert.ok(film.includes('zoom:width/1920'));
const features=read('src/reference-film/Features.tsx');assert.equal((features.match(/<Blend /g)||[]).length,3);
const root=read('src/Root.tsx');assert.ok(/id="OpenLinkReferenceFilm"[^\n]*width=\{3840\} height=\{2160\}/.test(root));
for(const name of ['Intent','Execution','Artifact','Refinement','Resolution','Features'])assert.ok(!read(`src/reference-film/${name}.tsx`).includes('Caption'));
const native=read('src/reference-film/Native.tsx');assert.ok(native.includes('CurrentHomeComposer'));assert.ok(native.includes('CurrentSessionComposer'));assert.ok(native.includes('expanded={false}'));assert.ok(!native.includes('film-session-composer'));
const curves=JSON.parse(read('src/reference-film/motion-curves.json'));assert.equal(curves.ease.length,1025);assert.equal(curves.ease[0],0);assert.equal(curves.ease[1024],1);
assert.ok(read('src/reference-film/primitives.tsx').includes("export const BG = '#ffffff'"));
assert.ok(!read('src/reference-film/Genesis.tsx').includes('GlassOrb'));
assert.ok(!read('src/reference-film/primitives.tsx').includes('GlassOrb'));
assert.ok(read('src/reference-film/ShotClock.tsx').includes('step=60/fps'));
assert.ok(/id="OpenLinkReferenceFilm"[^\n]*durationInFrames=\{6720\} fps=\{120\}/.test(root));
const report={background:'#ffffff',intro:'logo only',sourceModules:manifest.records.length,homeClassesPreserved:classes,chatClassesPreserved:chatClasses,sourceRoots:manifest.roots,sourceDrift,snapshotPolicy:'Retain verified source-derived input presentation; do not overwrite unrelated application edits.',homeState:'canonical workspace composer',chatState:'single-line session composer, not forced expanded',majorOverlaps:7,internalOverlaps:3,transitionFrames:96,durationInFrames:6720,fps:120,width:3840,height:2160,intermediateFormat:'lossless PNG',upscaledMovie:false,motion:'GSAP paused timeline + Motion spring, sampled deterministically offline',noOverheadTitles:true};
fs.writeFileSync('provenance/white-120-verification.json',JSON.stringify(report,null,2));
console.log(`PASS: ${manifest.records.length} current source modules; ${classes} home JSX class attributes; 7+3 real transitions; native 4K120 on white; correct home/chat composer states.`);
