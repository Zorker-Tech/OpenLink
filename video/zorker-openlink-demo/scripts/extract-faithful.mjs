import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import ts from 'typescript';

const project=process.cwd(), repo=path.resolve(project,'../..');
const records=[];
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const write=(p,s)=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,s);};
const read=p=>fs.readFileSync(path.join(repo,p),'utf8');
const ast=(text)=>ts.createSourceFile('source.tsx',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function declaration(text,name) {
  const tree=ast(text);
  const node=tree.statements.find(n=>n.name?.text===name||ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>d.name.getText(tree)===name));
  if(!node) throw Error(`Missing declaration: ${name}`);
  return {node,tree,text:node.getText(tree)};
}
function replaceDeclaration(text,name,value) {
  const {node}=declaration(text,name);
  return text.slice(0,node.getStart())+value+text.slice(node.end);
}
function inertJsx(text) {
  const tree=ast(text), edits=[];
  const visit=n=>{
    if(ts.isJsxAttribute(n)&&(/^on[A-Z]/.test(n.name.getText(tree))||n.name.getText(tree)==='ref'||n.name.getText(tree)==='autoFocus')) {
      edits.push([n.getStart(tree),n.end,'']);return;
    }
    ts.forEachChild(n,visit);
  };
  visit(tree);
  for(const [a,b,s] of edits.sort((a,b)=>b[0]-a[0])) text=text.slice(0,a)+s+text.slice(b);
  return text;
}
const timelinePath='components/chat-timeline.tsx';
let timeline=read(timelinePath);
// Preserve complete real reducer, round projection, render hierarchy, JSX and classes.
timeline=replaceDeclaration(timeline,'TaskPositionCapsule','function TaskPositionCapsule() { return null; }');
const editor=declaration(timeline,'EditableUserMessage').text;
timeline=replaceDeclaration(timeline,'EditableUserMessage',`function EditableUserMessage({item,disabled,onEditMessage=()=>{}}) {
 const {editing,pending,draft}=useContext(FilmState);
 const t=useT();
 const error=null;
 ${editor.slice(editor.indexOf('  return <div'))}
`);
for(const name of ['TaskExecutionRow','TaskGroupItem','WorkFlowGroup','ChangeItem']) {
  let part=declaration(timeline,name).text;
  part=part.replace(/const \[open, setOpen\] = useState\([^\n]+\)/,name==='WorkFlowGroup'?'const open = round.state === "working"':name==='TaskGroupItem'?'const open = true':name==='ChangeItem'?'const open = useContext(FilmState).changesOpen':'const open = false');
  if(name==='WorkFlowGroup') {
    const start=part.indexOf('  useEffect('), end=part.indexOf('  return (',start);
    part=part.slice(0,start)+part.slice(end);
  }
  timeline=replaceDeclaration(timeline,name,part);
}
timeline=timeline.replace('Date.now()', '1788755400000');
timeline=inertJsx(timeline);
timeline=timeline.replace("from '@/components/ai-elements/conversation'", "from '../../adapters/conversation'")
 .replace("from '@/components/thinking/src'", "from '../../adapters/orb'");
timeline=`import {useContext} from 'react';\nimport {FilmState} from '../../adapters/state';\n`+timeline;
const translations={
 '从此处重新生成后续对话，不回滚文件修改。':'Regenerates the conversation from here. File changes are not rolled back.',
 '正在重发…':'Resending…','重发':'Resend','取消':'Cancel','编辑原消息':'Edit original message','消息内容':'Message content','编辑消息：':'Edit message: ',
 '正在编辑':'Editing','编辑失败':'Edit failed','正在生成回复':'Composing reply','生成回复':'Reply composed','正在思考':'Thinking','完成思考':'Thought',
};
for(const [a,b] of Object.entries(translations)) timeline=timeline.replaceAll(a,b);
timeline=timeline.replace("'文件' : `${count} 个文件`", "'a file' : `${count} files`");

const workspace=read('components/chat-workspace.tsx');
const composerSource=declaration(workspace,'ChatComposer').text;
const tree=ast(composerSource);
let inputNode,modelTrigger;
function visit(n){
 if(ts.isJsxElement(n)) {
  const tag=n.openingElement.tagName.getText(tree);
  if(tag==='PromptInput') inputNode=n;
  if(tag==='ModelSelectorTrigger') modelTrigger=n;
 }
 ts.forEachChild(n,visit);
}
visit(tree);
if(!inputNode||!modelTrigger) throw Error('Composer structure changed');
let input=inertJsx(inputNode.getText(tree));
const inputTree=ast(input), edits=[];
function prune(n){
 if(ts.isJsxExpression(n)&&/^\{(?:pastedTextAttachments|referenceAttachments)\.length \?/.test(n.getText(inputTree))) {edits.push([n.getStart(),n.end,'']);return;}
 ts.forEachChild(n,prune);
}
prune(inputTree);
for(const [a,b,s] of edits.sort((a,b)=>b[0]-a[0])) input=input.slice(0,a)+s+input.slice(b);
input=input.replace('<PromptInput\n','<PromptInput onSubmit={() => {}}\n').replace('<AgentPromptTextarea','<AgentPromptTextarea onValueChange={() => {}} readOnly')
 .replace('<ComposerAttachments />','').replace('onStop={onInterrupt}','')
 .replace('!selectedModel','false');
let submit=declaration(workspace,'ComposerSubmitButton').text;
submit=inertJsx(submit);
for(const [a,b] of Object.entries({'加入队列':'Queue message','停止':'Stop','发送':'Send'})) submit=submit.replaceAll(a,b);
const composer=`import React from 'react';
import {PromptInput,PromptInputButton,PromptInputSubmit,usePromptInputAttachments} from '@/components/ai-elements/prompt-input';
import {AgentPromptTextarea} from '@/components/agent-prompt-textarea';
import {PromptAddMenu} from '@/components/prompt-add-menu';
import {ModelSelector,ModelSelectorTrigger,ModelSelectorLogo} from '@/components/ai-elements/model-selector';
import {ChevronDown,Send,Square} from 'lucide-react';
${submit}
export function SessionComposer({text='',expanded=false,busy=false}) {
 const input=text,status=busy?'streaming':'idle',controlPending=false;
 const composerResources={agent:'codex',customInstructions:'',skills:[]};
 const accessMode='full',codexResources=null,runtimeResources=null,commandsLoaded=true,promptResourcesLoading=false;
 const promptSuggestions=[],pastedTextAttachments=[],referenceAttachments=[];
 const selectedModel={name:'Demo configured model',logo:'openai'};
 const actionButtons=<ModelSelector open={false}>${inertJsx(modelTrigger.getText(tree))}</ModelSelector>;
 return <div className="flex w-full flex-col gap-1.5">${input}</div>;
}`;
const overrides=new Map([[timelinePath,timeline],['components/film-session-composer.tsx',composer],['components/film-reference-timeline.tsx',read(timelinePath)]]);
const visited=new Set();
function resolveLocal(base,spec) {
 const bare=spec.startsWith('@/')?spec.slice(2):path.posix.normalize(path.posix.join(path.posix.dirname(base),spec));
 for(const suffix of ['', '.tsx','.ts','.js','/index.tsx','/index.ts']) if(fs.existsSync(path.join(repo,bare+suffix))&&fs.statSync(path.join(repo,bare+suffix)).isFile())return bare+suffix;
 throw Error(`Cannot resolve ${base}: ${spec}`);
}
function capture(file) {
 if(visited.has(file))return;
 visited.add(file);
 const original=file==='components/film-session-composer.tsx'?composerSource:file==='components/film-reference-timeline.tsx'?read(timelinePath):read(file);
 const contents=overrides.get(file)??original;
 const js=ts.transpileModule(contents,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
 const parsed=ts.createSourceFile(file,js,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
 const edits=[];
 for(const n of parsed.statements) {
  if((ts.isImportDeclaration(n)||ts.isExportDeclaration(n))&&n.moduleSpecifier&&ts.isStringLiteral(n.moduleSpecifier)) {
   const spec=n.moduleSpecifier.text;
   if(spec.includes('/adapters/'))continue;
   if(spec==='server-only'||spec.startsWith('node:'))throw Error(`Server boundary: ${file} -> ${spec}`);
   if(spec.startsWith('@/')||spec.startsWith('.')) {
    const target=resolveLocal(file,spec);capture(target);
    let relative=path.posix.relative(path.posix.dirname(file),target).replace(/\.(tsx?|js)$/,'.js');
    if(!relative.startsWith('.'))relative='./'+relative;
    edits.push([n.moduleSpecifier.getStart(parsed),n.moduleSpecifier.end,JSON.stringify(relative)]);
   }
  }
 }
 let output=js;
 for(const [a,b,s] of edits.sort((a,b)=>b[0]-a[0]))output=output.slice(0,a)+s+output.slice(b);
 const dest=`src/source-snapshot/${file.replace(/\.(tsx?|js)$/,'.js')}`;
 write(path.join(project,dest),output);
 records.push({source:file==='components/film-session-composer.tsx'?'components/chat-workspace.tsx:ChatComposer + ComposerSubmitButton':file==='components/film-reference-timeline.tsx'?timelinePath:file,sourceSha256:hash(original),output:dest,outputSha256:hash(output),method:overrides.has(file)&&file!=='components/film-reference-timeline.tsx'?'source presentation with explicit frame adaptation':'TypeScript transpilation, local imports rebased; no presentation edits'});
}
capture(timelinePath);capture('components/film-session-composer.tsx');capture('components/film-reference-timeline.tsx');
// Capture the very same canvas painters; no substitute spinner.
capture('components/thinking/src/presets.ts');capture('components/thinking/src/engine/registry.ts');
fs.mkdirSync('public/fonts',{recursive:true});
fs.copyFileSync(path.join(repo,'app/fonts/geist-latin.woff2'),'public/fonts/geist-latin.woff2');
records.push({source:'app/fonts/geist-latin.woff2',output:'public/fonts/geist-latin.woff2',sourceSha256:hash(fs.readFileSync('public/fonts/geist-latin.woff2'))});
write('provenance/faithful-manifest.json',JSON.stringify({baseCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),workingTree:'Source contains existing user modifications; hashes are authoritative.',records,adaptations:['ChatTimeline retains real event reducer, round grouping, nested task presentation and summary/change placement.','Editor, workflow and task disclosure are frame-controlled; UI action attributes removed from timeline. No source app changes.','Session composer is extracted from ChatComposer, not WorkspacePrompt. Empty attachment/queue/goal states; closed original menus; no service callbacks.','Conversation auto-scroll becomes static source-class containers; offscreen TaskPositionCapsule omitted because all shown tasks fit.','Original orb canvas painters use frame/fps instead of performance clock.','English labels, deterministic timestamps and fictional events/results.','Source Geist font copied locally. Root dependency installation supplies pinned existing UI packages.','Monaco file detail is outside shot scope and remains closed; no substitute code renderer in the timeline.'],reference:{path:'/Users/yikewang/Tibo-Please',used:'Inspected source: glyph relay, focused camera and settled holds. Not a claim of watching a finished reference video.'},rights:'User-supplied OpenLink source, brand and font for requested video; dependency licenses still apply. No purchased or external generated media.'},null,2));
console.log(`Captured ${records.length} source records.`);
