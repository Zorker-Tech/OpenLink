import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import ts from 'typescript';
import assert from 'node:assert/strict';
const repo=path.resolve('../..'),out='src/reference-film/current-ui',records=[],assets=[];
const read=p=>fs.readFileSync(path.join(repo,p),'utf8');
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const ast=s=>ts.createSourceFile('file.tsx',s,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function declaration(s,name){const a=ast(s);let n;function visit(node){if(n)return;if(node.name?.text===name||ts.isVariableStatement(node)&&node.declarationList.declarations.some(d=>d.name.getText(a)===name)){n=node;return;}ts.forEachChild(node,visit);}visit(a);assert.ok(n,name);return {a,n,text:n.getText(a)};}
function inert(s){const a=ast(s),edits=[];function visit(n){if(ts.isJsxAttribute(n)&&(/^on[A-Z]/.test(n.name.getText(a))||['ref','autoFocus'].includes(n.name.getText(a)))){edits.push([n.getStart(a),n.end]);return;}ts.forEachChild(n,visit);}visit(a);for(const [x,y]of edits.sort((a,b)=>b[0]-a[0]))s=s.slice(0,x)+s.slice(y);return s;}
function inputMarkup(s,name){const {n,a}=declaration(s,name);let result;function visit(n){if(ts.isJsxElement(n)&&n.openingElement.tagName.getText(a)==='PromptInput')result=n.getText(a);ts.forEachChild(n,visit);}visit(n);assert.ok(result);return inert(result).replace('<PromptInput','<PromptInput onSubmit={() => {}}').replace('<AgentPromptTextarea','<AgentPromptTextarea onValueChange={() => {}} readOnly');}
const homeSource=read('components/workspace-prompt.tsx'),chatSource=read('components/chat-workspace.tsx');
const homeDecl=declaration(homeSource,'WorkspacePrompt');
const homeAttachments=declaration(homeSource,'WorkspacePromptAttachments').text;
const homeReturn=homeDecl.n.body.statements.filter(ts.isReturnStatement).at(-1).getText(homeDecl.a);
const imports=`import React from 'react';
import {staticFile} from 'remotion';
import {PromptInput,PromptInputBody,PromptInputFooter,PromptInputTools,PromptInputButton,PromptInputSubmit,usePromptInputAttachments} from '@/components/ai-elements/prompt-input';
import {AgentPromptTextarea} from '@/components/agent-prompt-textarea';
import {PromptAddMenu} from '@/components/prompt-add-menu';
import {AccessModePicker} from '@/components/access-mode-picker';
import {AgentKindPicker} from '@/components/agent-kind-picker';
import {ModelSelector,ModelSelectorTrigger,ModelSelectorContent,ModelSelectorInput,ModelSelectorList,ModelSelectorEmpty,ModelSelectorGroup,ModelSelectorItem,ModelSelectorName,ModelSelectorLogo} from '@/components/ai-elements/model-selector';
import {Attachment,AttachmentInfo,AttachmentPreview,AttachmentRemove,Attachments} from '@/components/ai-elements/attachments';
import {BookOpenText,Code2,Plus,Send,Square,ChevronDown,FileText,MessageCircle,X} from 'lucide-react';
import {useT} from '@/lib/i18n/client';
const model={id:'demo-model',name:'GPT-6 Luna',providerName:'OpenAI',logo:'openai',isDefault:true};
`;
let home=`${imports}
${inert(homeAttachments)}
/** @param {{text?:string}} props */
export function CurrentHomeComposer({text=''}) {
 const t=useT(),input=text,agentKind='codex',runtimeReady=true,runtimeHintId='film-home-hint',runtimeHint='What shall we build?',accessMode='restricted',modelSelectorOpen=false,projectSelectorOpen=false,selectedModel=model,selectedProject=null,modelGroups=new Map([['OpenAI',[model]]]),selectableProjects=[],renderExtraTools=null,submitError=null,promptSuggestions=[];
 ${inert(homeReturn).replace('<PromptInput','<PromptInput onSubmit={() => {}}').replace('<AgentPromptTextarea','<AgentPromptTextarea onValueChange={() => {}} readOnly')}
}`;
let chat=`${imports}
${inert(declaration(chatSource,'ComposerSubmitButton').text)}
${inert(declaration(chatSource,'ComposerAttachments').text)}
/** @param {{text?:string,expanded?:boolean,busy?:boolean}} props */
export function CurrentSessionComposer({text='',expanded=false,busy=false}) {
 const t=useT(),input=text,status=busy?'streaming':'idle',controlPending=false,selectedModel=model,composerResources={agent:'codex',customInstructions:'',skills:[]},accessMode='restricted',codexResources=null,runtimeResources=null,commandsLoaded=true,promptResourcesLoading=false,promptResourcesError=null,promptResourceRequest=null,promptSuggestions=[],pastedTextAttachments=[],referenceAttachments=[],instructionAttachments=[],modelSelectorOpen=false,modelGroups=new Map([['OpenAI',[model]]]),availableModels=[model];
 ${inert(declaration(declaration(chatSource,'ChatComposer').text,'actionButtons').text)}
 return <div className="relative flex w-full flex-col gap-1.5">${inputMarkup(chatSource,'ChatComposer')}</div>;
}`;
// declarations nested in the function need their own AST body lookup.
for(const [file,content]of [['components/film-home-composer.tsx',home],['components/film-chat-composer.tsx',chat]]) {
 const normalized=content.replaceAll('src="/openlink/app/prompt-chevron.svg"',"src={staticFile('openlink/app/prompt-chevron.svg')}");
 if(file.includes('home'))home=normalized;else chat=normalized;
}
const overrides=new Map([['components/film-home-composer.tsx',home],['components/film-chat-composer.tsx',chat]]),seen=new Set();
function resolve(base,spec){const bare=spec.startsWith('@/')?spec.slice(2):path.posix.normalize(path.posix.join(path.posix.dirname(base),spec));for(const ext of ['','.tsx','.ts','.js','/index.tsx','/index.ts'])if(fs.existsSync(path.join(repo,bare+ext))&&fs.statSync(path.join(repo,bare+ext)).isFile())return bare+ext;throw Error(`${base}: ${spec}`);}
function capture(file){if(seen.has(file))return;seen.add(file);const original=overrides.get(file)??read(file);const compiled=ts.transpileModule(original,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;const a=ts.createSourceFile(file,compiled,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),edits=[];for(const n of a.statements)if((ts.isImportDeclaration(n)||ts.isExportDeclaration(n))&&n.moduleSpecifier&&ts.isStringLiteral(n.moduleSpecifier)){const spec=n.moduleSpecifier.text;if(spec==='server-only'||spec.startsWith('node:')||spec.startsWith('next/'))throw Error('Runtime boundary: '+spec);if(spec.startsWith('@/')||spec.startsWith('.')){const target=resolve(file,spec);capture(target);let relative=path.posix.relative(path.posix.dirname(file),target).replace(/\.(tsx?|js)$/,'.js');if(!relative.startsWith('.'))relative='./'+relative;edits.push([n.moduleSpecifier.getStart(a),n.moduleSpecifier.end,JSON.stringify(relative)]);}}let js=compiled;for(const [x,y,v]of edits.sort((a,b)=>b[0]-a[0]))js=js.slice(0,x)+v+js.slice(y);let rebased=false;js=js.replace(/(["'])\/openlink\/([^"']+)\1/g,(match,quote,asset)=>{const src=path.join(repo,'public/openlink',asset);if(!fs.existsSync(src))return match;const target=path.join('public/openlink',asset);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(src,target);assets.push({source:'public/openlink/'+asset,output:target,sha256:hash(fs.readFileSync(src))});rebased=true;return 'filmStaticFile('+JSON.stringify('openlink/'+asset)+')';});if(rebased)js="import {staticFile as filmStaticFile} from 'remotion';\n"+js;const output=`${out}/${file.replace(/\.(tsx?|js)$/,'.js')}`;fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,js);records.push({source:file,sourceSha256:hash(original),output,outputSha256:hash(js),method:overrides.has(file)?'current source JSX with deterministic fixture state and inert callbacks':'current source TypeScript transpilation with import rebasing only'});}
capture('components/film-home-composer.tsx');capture('components/film-chat-composer.tsx');
fs.mkdirSync('public/openlink/app',{recursive:true});fs.copyFileSync(path.join(repo,'public/openlink/app/prompt-chevron.svg'),'public/openlink/app/prompt-chevron.svg');
const css=read('app/globals.css').replace(/^@(import|source).*\n/gm,'');fs.writeFileSync('src/reference-film/current-theme.css',css);
fs.writeFileSync('provenance/current-composers.json',JSON.stringify({roots:[{source:'components/workspace-prompt.tsx',symbol:'WorkspacePrompt',sha256:hash(homeSource),output:'components/film-home-composer.tsx'},{source:'components/chat-workspace.tsx',symbol:'ChatComposer / ComposerSubmitButton / ComposerAttachments',sha256:hash(chatSource),output:'components/film-chat-composer.tsx'}],records,css:{source:'app/globals.css',sha256:hash(read('app/globals.css')),output:'src/reference-film/current-theme.css',outputSha256:hash(css)},modelFixture:{name:'GPT-6 Luna',liveProviderCall:false},adaptations:['Homepage uses current WorkspacePrompt with Zorker/agent, disabled Cloud and active Local, permission, named GPT-6 Luna demonstration model, project entry and round send button.','Chat uses current compact single-line composer unless actual wrapping requires expansion. No forced expanded state.','Menus remain closed, attachments empty, service callbacks inert. GPT-6 Luna is a deterministic film fixture, not a live provider selection or model-availability claim.','Current dependencies, JSX, CSS classes and SVG assets retained. No source application changes.']},null,2));
fs.writeFileSync('provenance/current-composer-assets.json',JSON.stringify(assets,null,2));
console.log('Captured current composers and '+records.length+' source modules.');
