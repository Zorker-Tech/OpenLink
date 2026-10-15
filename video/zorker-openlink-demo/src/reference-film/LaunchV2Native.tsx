import {useRef} from 'react';
import {ChatTimeline} from '../source-snapshot/components/chat-timeline.js';
import {FilmState} from './state';
import {FilmTimelineUi} from './FilmLocale';
import {SourceGitSnapshot} from './source/timeline.js';
import {at,useGsapScrub} from './Choreography';

export const LAUNCH_V2_QUESTION='On Dash XV mobile, shoppers choose a size, then lose the buy button. Keep the next step in view.';
export const LAUNCH_V2_REVISION='Keep the layout. Make the purchase action feel unmistakable.';

const patch=[
 '@@ -88,7 +88,13 @@',
 '- <button className="buy-button">Add to bag</button>',
 '+ <div className="mobile-buybar">',
 '+   <span>Size 09 selected</span>',
 '+   <button className="buy-button">Add to bag</button>',
 '+ </div>',
].join('\n');
const changeFile={path:'src/app/product/[slug]/page.tsx',additions:6,deletions:1,patch};
export const LAUNCH_V2_CHANGE={
  version:1,
  sessionId:'dash-xv-illustrative',
  source:'codex',
  sequence:14,
  timestamp:'2026-10-12T10:00:00.000Z',
  type:'file.changed',
  changeId:'dash-xv-mobile-buybar',
  label:'Keep the purchase action in view',
  additions:6,
  deletions:1,
  files:[changeFile],
  snapshot:true,
};

const fullEvents=[
  {at:0,type:'message.user',messageId:'dash-xv-request',text:LAUNCH_V2_QUESTION},
  {at:1,type:'session.started'},
  {at:24,type:'task.updated',taskId:'trace',label:'Trace the size selection',detail:'Size picker → purchase action',status:'completed'},
  {at:25,type:'tool.started',toolId:'read-size-flow',taskId:'trace',name:'read_file',input:{path:'app/products/[slug]/page.tsx'}},
  {at:40,type:'tool.completed',toolId:'read-size-flow',taskId:'trace',output:'The selected size is already stored.'},
  {at:48,type:'task.updated',taskId:'viewport',label:'Check the mobile viewport',detail:'Confirm the action slips below the fold',status:'completed'},
  {at:49,type:'tool.started',toolId:'inspect-mobile',taskId:'viewport',name:'inspect_preview',input:{viewport:'390 × 844'}},
  {at:64,type:'tool.completed',toolId:'inspect-mobile',taskId:'viewport',output:'The purchase action sits below the fold.'},
  {at:72,type:'task.updated',taskId:'patch',label:'Keep the action with the choice',detail:'Add a sticky mobile buy bar',status:'completed'},
  {at:73,type:'file.editing.started',editId:'buybar-intro',taskId:'patch',path:changeFile.path,operation:'edit'},
  {at:91,type:'file.editing.completed',editId:'buybar-intro',taskId:'patch',path:changeFile.path,operation:'edit'},
  {at:96,type:'task.updated',taskId:'review',label:'Prepare the focused change',detail:'Preview the page and inspect the diff',status:'completed'},
  {at:97,type:'command.started',commandId:'first-build',taskId:'review',command:'pnpm build'},
  {at:118,type:'command.completed',commandId:'first-build',taskId:'review',exitCode:0,output:'Build completed.'},
  {at:512,type:'message.completed',messageId:'dash-xv-answer',text:'The size choice was already working. On a short viewport, the buy action fell below the fold.'},
  {at:544,type:'file.changed',...LAUNCH_V2_CHANGE},
  {at:550,type:'session.completed'},
];

export function launchV2EventsAt(frame:number){
 return fullEvents.filter((event)=>event.at<=frame).map(({at:time,...event},index)=>({
  ...event,
  sessionId:'dash-xv-illustrative',
  source:'codex',
  sequence:index+1,
  timestamp:new Date(1788595200000+time*1000/60).toISOString(),
 }));
}

export function LaunchV2Timeline({frame,width=640,height=610}:{frame:number;width?:number;height?:number}){
 const events=launchV2EventsAt(frame),complete=frame>=550;
 return <div data-openlink-theme="light" className="light" style={{width,height,position:'relative',background:'transparent',overflow:'hidden'}}>
  <FilmState.Provider value={{editing:false,pending:false,draft:LAUNCH_V2_QUESTION,changesOpen:true,workflowOpen:true}}>
   <FilmTimelineUi><ChatTimeline events={events} isStreaming={!complete} onFlowStatusChange={undefined} onEditMessage={undefined}/></FilmTimelineUi>
  </FilmState.Provider>
 </div>;
}

export function LaunchV2ChangeCard({animationFrame=0}:{animationFrame?:number}){
 const ref=useRef<HTMLDivElement>(null);
 useGsapScrub(ref,animationFrame,(timeline,element)=>{
  const card=element.querySelector('[data-slot="git-snapshot"]')||element.firstElementChild;
  const file=element.querySelector('[aria-pressed]'),code=element.querySelector('pre');
  if(card)timeline.fromTo(card,{y:20,opacity:0},{y:0,opacity:1,duration:.52,ease:'power3.out'},at(-16));
  if(file)timeline.fromTo(file,{x:-14,opacity:0},{x:0,opacity:1,duration:.4,ease:'power3.out'},at(14));
  if(code)timeline.fromTo(code,{y:14,opacity:0},{y:0,opacity:1,duration:.42,ease:'power2.out'},at(30));
 },'launch-v2-diff',animationFrame!==undefined);
 return <div ref={ref} data-openlink-theme="light" className="light" style={{width:610,background:'transparent'}}>
  <FilmState.Provider value={{editing:false,pending:false,draft:'',changesOpen:true,workflowOpen:false}}>
   <FilmTimelineUi><SourceGitSnapshot item={{...LAUNCH_V2_CHANGE,id:'dash-xv-change-card',kind:'change'}}/></FilmTimelineUi>
  </FilmState.Provider>
 </div>;
}
