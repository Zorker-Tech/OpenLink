import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import ts from 'typescript';
const read=p=>fs.readFileSync(p,'utf8');
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const manifest=JSON.parse(read('provenance/faithful-manifest.json'));
for(const r of manifest.records)if(r.outputSha256)assert.equal(hash(read(r.output)),r.outputSha256,`Changed snapshot ${r.output}`);
const timeline=read('src/source-snapshot/components/chat-timeline.js');
const original=read('../../components/chat-timeline.tsx');
const tree=ts.createSourceFile('source.tsx',original,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const compiled=ts.createSourceFile('snapshot.js',timeline,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
const strings=new Set();
function collect(n){if(ts.isStringLiteral(n)||ts.isNoSubstitutionTemplateLiteral(n))strings.add(n.text);ts.forEachChild(n,collect);}
collect(compiled);
let preservedClasses=0;
for(const name of ['TaskExecutionRow','TaskGroupItem','WorkFlowGroup','TimelineMessageItem','EditableUserMessage','EndingSection']) {
 const node=tree.statements.find(n=>n.name?.text===name);assert.ok(node,name);
 function visit(n){if(ts.isJsxAttribute(n)&&n.name.getText(tree)==='className'&&n.initializer&&ts.isStringLiteral(n.initializer)){assert.ok(strings.has(n.initializer.text),`${name} class changed: ${n.initializer.text}`);preservedClasses++;}ts.forEachChild(n,visit);}
 visit(node);
 assert.ok(timeline.includes(`function ${name}(`));
}
for(const name of ['buildTimeline','buildConversationRounds','projectMessageRevisions'])assert.ok(timeline.includes(name));
assert.ok(!/Date.now\(|performance.now\(|requestAnimationFrame\(|fetch\(/.test(timeline));
const composer=read('src/source-snapshot/components/film-session-composer.js');
assert.ok(composer.includes('h-[42px]'));
assert.ok(composer.includes('min-h-[108px]'));
assert.ok(composer.includes('AgentPromptTextarea'));
assert.ok(composer.includes('variant: "session"'));
assert.ok(!composer.includes('Cloud'));
assert.ok(!/fetch\(|crypto.randomUUID|setTimeout\(/.test(composer));
const journey=read('src/scenes/Journey.tsx');
for(const legacy of ['AgentWork','const Composer=','const headings=','const captions=','eyebrow','borderRadius:18'])assert.ok(!journey.includes(legacy),`Presentation wrapper returned: ${legacy}`);
assert.ok(journey.includes('SourceTimeline'));
assert.ok(journey.includes('SessionComposer'));
assert.ok(journey.includes('ThinkingOrb'));
assert.ok(journey.includes('trackedFrontAt'));
assert.ok(journey.includes('typedCountAt'));
assert.ok(journey.includes('IDEAS'));
assert.ok(journey.includes('TO'));
assert.ok(journey.includes('SYSTEM.'));
assert.ok(!/Date\.now\(|performance\.now\(|requestAnimationFrame\(|setTimeout\(/.test(journey));
console.log(`PASS: ${manifest.records.length} provenance records; ${preservedClasses} original timeline class attributes; real session input; clock-free timeline; no slide wrapper; deterministic typing-front camera; source orb and narrative layers.`);
