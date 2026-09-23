// Extract actual OpenLink presentation. No app files or old snapshots are changed.
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const root=path.resolve('../..'),dest='src/reference-film/source';
fs.mkdirSync(dest,{recursive:true});
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const source=fs.readFileSync(path.join(root,'components/chat-workspace.tsx'),'utf8');
const tree=ts.createSourceFile('source.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const declaration=name=>{const n=tree.statements.find(n=>n.name?.text===name);assert.ok(n,name);return n;};
const inert=text=>{
 const ast=ts.createSourceFile('inert.tsx',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),edits=[];
 const visit=n=>{if(ts.isJsxAttribute(n)&&(/^on[A-Z]/.test(n.name.text)||['ref','autoFocus'].includes(n.name.text))){edits.push([n.getStart(ast),n.end]);return;}ts.forEachChild(n,visit);};visit(ast);
 for(const [a,b] of edits.sort((a,b)=>b[0]-a[0]))text=text.slice(0,a)+text.slice(b);
 return text;
};
const removeJsxBranches=(text,shouldRemove)=>{
 const ast=ts.createSourceFile('presentation.tsx',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),edits=[];
 const visit=n=>{if(ts.isJsxExpression(n)&&n.expression&&shouldRemove(n.expression.getText(ast))){edits.push([n.getStart(ast),n.end]);return;}ts.forEachChild(n,visit);};visit(ast);
 for(const [a,b]of edits.sort((a,b)=>b[0]-a[0]))text=text.slice(0,a)+text.slice(b);
 return text;
};
const removeJsxElements=(text,tagName)=>{
 const ast=ts.createSourceFile('presentation.tsx',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),edits=[];
 const visit=n=>{if(ts.isJsxSelfClosingElement(n)&&n.tagName.getText(ast)===tagName){edits.push([n.getStart(ast),n.end]);return;}ts.forEachChild(n,visit);};visit(ast);
 for(const [a,b]of edits.sort((a,b)=>b[0]-a[0]))text=text.slice(0,a)+text.slice(b);
 return text;
};
const staticMotion=text=>{
 const ast=ts.createSourceFile('motion.tsx',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),edits=[];
 const visit=n=>{
  if(ts.isJsxOpeningElement(n)||ts.isJsxSelfClosingElement(n)){
   const tag=n.tagName.getText(ast);
   if(tag==='motion.div'){
    edits.push([n.tagName.getStart(ast),n.tagName.end,'div']);
    for(const prop of n.attributes.properties)if(ts.isJsxAttribute(prop)&&['animate','exit','initial','layout','transition'].includes(prop.name.getText(ast)))edits.push([prop.getStart(ast),prop.end,'']);
   }else if(tag==='AnimatePresence'){
    edits.push([n.tagName.getStart(ast),n.tagName.end,'React.Fragment']);
    for(const prop of n.attributes.properties)if(ts.isJsxAttribute(prop))edits.push([prop.getStart(ast),prop.end,'']);
   }
  }else if(ts.isJsxClosingElement(n)){
   const tag=n.tagName.getText(ast);
   if(tag==='motion.div')edits.push([n.tagName.getStart(ast),n.tagName.end,'div']);
   if(tag==='AnimatePresence')edits.push([n.tagName.getStart(ast),n.tagName.end,'React.Fragment']);
  }
  ts.forEachChild(n,visit);
 };visit(ast);
 for(const [a,b,value]of edits.sort((a,b)=>b[0]-a[0]))text=text.slice(0,a)+value+text.slice(b);
 return text;
};
const findElement=(node,tag)=>{let result;const walk=n=>{if(!result&&ts.isJsxElement(n)&&n.openingElement.tagName.getText(tree)===tag)result=n;ts.forEachChild(n,walk);};walk(node);return result;};
const topbar=declaration('ChatTopbar');
const topReturn=topbar.body.statements.filter(ts.isReturnStatement).at(-1).getText(tree);
const topbarElement=findElement(topbar,'header');assert.ok(topbarElement);
const chatBranch=topbarElement.children.find(n=>ts.isJsxExpression(n)&&n.expression?.getText(tree).startsWith("side === 'chat' &&"));assert.ok(chatBranch);
let chatMarkup=`${topbarElement.openingElement.getText(tree)}${chatBranch.getText(tree)}${topbarElement.closingElement.getText(tree)}`;
chatMarkup=removeJsxBranches(chatMarkup,expression=>expression.startsWith('context &&')||expression.startsWith('showWorkspaceLauncher &&'));
const chatAst=ts.createSourceFile('chat-topbar.tsx',chatMarkup,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),chatEdits=[];
const makeMotionStatic=n=>{
 if(ts.isJsxOpeningElement(n)&&n.tagName.getText(chatAst)==='motion.div'){
  const attrs=n.attributes.properties.filter(ts.isJsxAttribute),widthMotion=attrs.some(a=>a.name.getText(chatAst)==='animate'&&a.getText(chatAst).includes('width'));
  chatEdits.push([n.tagName.getStart(chatAst),n.tagName.end,'div']);
  for(const attr of attrs)if(['animate','initial','transition'].includes(attr.name.getText(chatAst)))chatEdits.push([attr.getStart(chatAst),attr.end,'']);
  if(widthMotion)chatEdits.push([n.attributes.end,n.attributes.end,' style={{width: titleWidth}}']);
 }
 ts.forEachChild(n,makeMotionStatic);
};makeMotionStatic(chatAst);
for(const [a,b,value]of chatEdits.sort((a,b)=>b[0]-a[0]))chatMarkup=chatMarkup.slice(0,a)+value+chatMarkup.slice(b);
chatMarkup=inert(chatMarkup);
const workspaceBranches=topbarElement.children.filter(n=>ts.isJsxExpression(n)&&n.expression?.getText(tree).startsWith("side === 'workspace'"));
assert.equal(workspaceBranches.length,2);
let workspaceMarkup=`${topbarElement.openingElement.getText(tree)}${workspaceBranches.map(n=>n.getText(tree)).join('')}${topbarElement.closingElement.getText(tree)}`;
workspaceMarkup=removeJsxElements(workspaceMarkup,'WorkspaceTabLauncher');
workspaceMarkup=inert(staticMotion(workspaceMarkup));
const workspaceTabsHelper=declaration('workspaceTabs').getText(tree);
const workspaceTabsComponent=staticMotion(inert(declaration('WorkspaceTabs').getText(tree).replace('const t = useT()','const t=filmT')));
const browserNavigation=declaration('BrowserNavigationBar');
const browserNavigationSource=staticMotion(inert(browserNavigation.getText(tree).replace('const t = useT()','const t=filmT')));
const preview=declaration('PreviewCanvas').body.statements.filter(ts.isReturnStatement).at(-1).getText(tree);
const menu=findElement(browserNavigation,'DropdownMenuContent').getText(tree);
// Keep the native menu's full child tree and styles; replace only portal primitives
// with their inert presentation tags, allowing the same menu to live under a film camera.
let menuPresentation=inert(menu).replace(/<DropdownMenuContent\b/,'<div').replace(/<\/DropdownMenuContent>/,'</div>').replaceAll('<DropdownMenuItem','<button type="button"').replaceAll('</DropdownMenuItem>','</button>').replace('align="end"','').replaceAll('<button type="button" className="','<button type="button" className="flex w-full items-center text-left ');
let wrapper=inert(preview).replace(/<BrowserWorkbench\s[^>]*\/>/,'<SourceBrowserSurface>{children}</SourceBrowserSurface>');
assert.ok(wrapper.includes('SourceBrowserSurface'));
let body=`import React,{useEffect,useRef,useState} from 'react';
import {staticFile} from 'remotion';
import {ArrowLeft,ArrowRight,ChevronDown,Code2,Database,Eye,ExternalLink,Globe2,Inspect,MessageCircle,MoreHorizontal,PanelLeft,RotateCw,Send,Share2,X} from 'lucide-react';
import {DropdownMenu,DropdownMenuContent,DropdownMenuItem,DropdownMenuTrigger} from '../../source-snapshot/components/ui/dropdown-menu.js';
${fs.readFileSync(path.join(root,'lib/theme.ts'),'utf8')}
${inert(declaration('ToolbarButton').getText(tree)).replace('function ToolbarButton','export function ToolbarButton')}
const filmT=(key,values={})=>{
 const copy={'预览':'Preview','实时浏览器':'Live','实时':'Live','代码':'Code','数据库':'Database','工作区标签':'Workspace tabs','关闭{label}标签':'Close {label} tab','评论':'Chat','更多':'More','分享':'Share','发布':'Publish','浏览器工具栏':'Browser toolbar','后退':'Back','前进':'Forward','设备':'Device','浏览器地址':'Browser address','输入网址或搜索':'Enter a URL or search','选择组件':'Select component','在新窗口打开':'Open externally','刷新':'Reload','更多预览选项':'More preview options','切换预览版本':'Switch preview version','当前':'Current','正在读取 Git 版本…':'Reading Git versions…','暂无可切换的 Git 版本':'No Git versions to switch',' · 当前提交':' · current commit'};
 return (copy[key]??key).replace(/\\{(\\w+)\\}/g,(_,name)=>String(values[name]??('{'+name+'}')));
};
${workspaceTabsHelper}
${workspaceTabsComponent}
${browserNavigationSource}
/** Current chat-side header JSX/layout from ChatTopbar; app actions are inert. */
export function SourceChatTopbar({title='Forma · Landing page'}={}) {
 const side='chat',collapsed=false,chatCollapsed=false,sessionTitle=title,editingTitle=false,titleDraft=title,savingTitle=false,titleWidth=176;
 const t=(key)=>({'打开侧边栏':'Open sidebar','展开侧边栏':'Expand sidebar','编辑项目名称':'Edit session name'}[key]??key);
 return ${chatMarkup};
}
export const exampleVersions=[{ref:'f173c02',shortRef:'f173c02',message:'Electric blue refinement',current:true},{ref:'b7401a8',shortRef:'b7401a8',message:'Warm neutral foundation',current:false}];
/** Current workspace-side ChatTopbar with one deterministic Preview tab. */
export function SourceTopbar() {
 const side='workspace',collapsed=false,chatCollapsed=false,localRuntime=false,dataSurface='panel',workspaceView='browser',activeTab='preview',openTabs=['preview'];
 const onToggleSidebar=()=>{},onToggleChat=()=>{},onToggleDataSurface=()=>{},onCloseWorkspaceTab=()=>{},onSelectWorkspaceTab=()=>{};
 const t=filmT;
 return ${workspaceMarkup};
}
/** @param {{selectedGitRef?:string|null}} props */
export function SourceVersionMenu({selectedGitRef=null}) {
 const t=filmT,gitVersions=exampleVersions,gitVersionsLoading=false,gitVersionError=null;
 return ${menuPresentation};
}
/** @param {{view?:string,children?:React.ReactNode,inspect?:boolean,selectedGitRef?:string|null}} props */
export function SourcePreviewCanvas({view='browser',children,inspect=false,selectedGitRef=null}) {
 const browserMode=view==='browser',workspaceView=view;
 const browserState={address:'forma.local',canGoBack:false,canGoForward:false,canInspect:true,externalUrl:'http://forma.local',inspectMode:inspect,status:'connected',surface:'native-preview'};
 const browserWorkbenchRef={current:null},sessionId='film-session',projectName='Forma website',panelProps={},dataSurface='panel';
 const gitVersions=exampleVersions,gitVersionsLoading=false,gitVersionError=null,onSelectGitVersion=()=>{},onToggleDeviceView=()=>{},onBrowserStateChange=()=>{},t=filmT;
 ${wrapper}
}
export function SourceBrowserSurface({children}) {
 return <section className="flex size-full min-h-0 flex-col bg-[var(--app-background)] text-[var(--app-foreground)]"><div className="relative min-h-0 flex-1 overflow-hidden bg-[var(--app-editor-background)]">{children}</div></section>;
}
`;
// Actual Chromium selection overlay; no remote stream or protocol runtime.
const chrom=fs.readFileSync(path.join(root,'components/browser/chromium-stream-surface.tsx'),'utf8');
const ct=ts.createSourceFile('chrom.tsx',chrom,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let overlay;
const visit=n=>{if(ts.isJsxElement(n)&&n.openingElement.attributes.properties.some(a=>ts.isJsxAttribute(a)&&a.name.text==='style'&&a.initializer?.getText(ct)==='{overlayStyle}'))overlay=n.getText(ct);ts.forEachChild(n,visit);};visit(ct);assert.ok(overlay);
body+=`export function SourceInspectorOverlay({bounds,label}) { const overlayStyle=bounds,selectedLabel=label;return ${inert(overlay)}; }`;
for(const [cn,en] of Object.entries({'评论':'Chat','预览':'Preview','实时':'Live','代码':'Code','数据':'Data','后退':'Back','前进':'Forward','设备':'Device','选择组件':'Select component','在新窗口打开':'Open externally','刷新':'Reload','更多预览选项':'More preview options','切换预览版本':'Switch preview version','当前提交':'Current commit','当前':'Current','更多':'More','分享':'Share','发布':'Publish','编辑项目名称':'Edit project name'}))body=body.replaceAll(cn,en);
body=body.replaceAll('Preview画布','Preview canvas');
body=body.replaceAll('src="/openlink/app/phone.svg"',"src={staticFile('openlink/app/phone.svg')}");
const js=ts.transpileModule(body,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX}}).outputText;
fs.writeFileSync(`${dest}/preview.js`,js);
fs.mkdirSync('public/openlink/app',{recursive:true});fs.copyFileSync(path.join(root,'public/openlink/app/phone.svg'),'public/openlink/app/phone.svg');
// New film-specific presentation adaptation preserves completed workflow details.
const oldFile='src/source-snapshot/components/chat-timeline.js',old=fs.readFileSync(oldFile,'utf8');
let timeline=old.replace('const open = round.state === "working";','const open = useContext(FilmState).workflowOpen ?? (round.state === "working");');
timeline=timeline.replace("checkpoint.metrics?.model ?? 'Fable 5'","checkpoint.metrics?.model ?? 'GPT-6 Luna'");
assert.ok(timeline.includes("checkpoint.metrics?.model ?? 'GPT-6 Luna'"),'Film timeline must use the requested GPT-6 Luna demonstration fixture.');
const ast=ts.createSourceFile('timeline.js',timeline,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),edits=[];
for(const n of ast.statements)if(ts.isImportDeclaration(n)&&n.moduleSpecifier&&ts.isStringLiteral(n.moduleSpecifier)) {
 const spec=n.moduleSpecifier.text;if(!spec.startsWith('.'))continue;
 let rel=path.relative(path.resolve(dest),path.resolve(path.dirname(oldFile),spec)).replaceAll(path.sep,'/');if(!rel.startsWith('.'))rel='./'+rel;
 if(spec==='../../adapters/state')rel='../state';
 edits.push([n.moduleSpecifier.getStart(ast),n.moduleSpecifier.end,JSON.stringify(rel)]);
}
for(const [a,b,s] of edits.sort((a,b)=>b[0]-a[0]))timeline=timeline.slice(0,a)+s+timeline.slice(b);
timeline+='\nexport {ChangeItem as SourceGitSnapshot};\n';fs.writeFileSync(`${dest}/timeline.js`,timeline);
const timelineSource=fs.readFileSync(path.join(root,'components/chat-timeline.tsx'),'utf8');
const report={sourceRepository:root,sourceFiles:[{path:'components/chat-workspace.tsx',sha256:hash(source),symbols:['ToolbarButton','ChatTopbar.chat','ChatTopbar.workspace','WorkspaceTabs','BrowserNavigationBar','PreviewCanvas'],method:'Current native JSX and classes extracted for both chat and workspace headers, tabs, browser navigation, and canvas; handlers, refs, and live runtime state neutralized into explicit deterministic fixture state.'},{path:'components/browser/browser-workbench.tsx',sha256:hash(fs.readFileSync(path.join(root,'components/browser/browser-workbench.tsx'),'utf8')),symbols:['BrowserWorkbench'],method:'Ready-state section/div retained; live connection state excluded; content child supplied as deterministic project fixture.'},{path:'components/browser/chromium-stream-surface.tsx',sha256:hash(chrom),symbols:['selection overlay'],method:'Exact overlay JSX/classes extracted; bounds and source label passed as fixture props.'},{path:'components/chat-timeline.tsx',sha256:hash(timelineSource),symbols:['ChatTimeline','ChangeItem'],method:'Latest source-snapshot JSX/classes used; timeline state and workflow disclosure are explicit deterministic frame props. Native markup/classes unchanged.'}],outputs:[{path:`${dest}/preview.js`,sha256:hash(js)},{path:`${dest}/timeline.js`,sha256:hash(timeline)}],modelFixture:{name:'GPT-6 Luna',liveProviderCall:false},limitations:['Actual NativePreviewSurface uses a nonce-bound iframe and live browser protocol. Film excludes those connections and supplies the illustrative Forma React content inside the extracted ready-state wrapper. This is not a live website capture.','Version hashes, inspector selection, GPT-6 Luna model label and generated files are deterministic fictional fixtures, not records of live product execution or proof of provider availability.','Native menu portal is replaced by inert presentation tags retaining source subtree and styles so it follows the film camera.'],noBusinessLogicWrites:true};
fs.writeFileSync('provenance/reference-preview-extraction.json',JSON.stringify(report,null,2));console.log('Extracted native toolbar, preview canvas, ready browser wrapper, inspector, Git menu and timeline.');
