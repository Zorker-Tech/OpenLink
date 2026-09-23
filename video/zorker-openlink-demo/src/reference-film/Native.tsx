import {useLayoutEffect,useRef,useState} from 'react';
import {flushSync} from 'react-dom';
import {continueRender,delayRender} from 'remotion';
import {CurrentHomeComposer} from './current-ui/components/film-home-composer.js';
import {CurrentSessionComposer} from './current-ui/components/film-chat-composer.js';
import {ChatTimeline,SourceGitSnapshot} from './source/timeline.js';
import {eventsAt} from '../adapters/Timeline';
import {FilmState} from './state';
import {FilmCurrentUi,FilmTimelineUi} from './FilmLocale';
import {at,layoutPoint,useGsapScrub} from './Choreography';

export const PROMPT='Build a landing page for Forma. Warm neutrals. Space to breathe.';
export const REVISION='Make it electric blue. Keep the layout.';
export type PromptGeometry={x:number;y:number;h:number;startX:number;fullWidth:number;submitX:number;submitY:number;fronts?:number[]};
export function frontAt(g:PromptGeometry,count:number){const i=Math.floor(count),p=count-i;return g.fronts?.length?(g.fronts[Math.min(i,g.fronts.length-1)]+((g.fronts[Math.min(i+1,g.fronts.length-1)]??0)-g.fronts[Math.min(i,g.fronts.length-1)])*p):g.fullWidth*count/Math.max(1,g.fronts?.length||60);}

export function NativePrompt({text,fullText=text,kind='chat',caret=false,width=700,busy=false,onGeometry,animationFrame,clickFrame}: {text:string;fullText?:string;kind?:'home'|'chat';caret?:boolean;width?:number;busy?:boolean;onGeometry?:(g:PromptGeometry)=>void;animationFrame?:number;clickFrame?:number}) {
 const host=useRef<HTMLDivElement>(null),callback=useRef(onGeometry);callback.current=onGeometry;
 const [handle]=useState(()=>delayRender('Measure source input once after font readiness'));
 const cleared=useRef(false);
 const [point,setPoint]=useState<PromptGeometry>({x:16,y:16,h:20,startX:16,fullWidth:400,submitX:675,submitY:136,fronts:[]});
 useLayoutEffect(()=>{
  let active=true;
  const finish=()=>{if(!cleared.current){cleared.current=true;continueRender(handle);}};
  document.fonts.ready.then(()=>{
   const el=host.current,ta=el?.querySelector('textarea');if(!active||!el||!ta){finish();return;}
   const style=getComputedStyle(ta),position=layoutPoint(ta,el),canvas=document.createElement('canvas').getContext('2d');
   if(!canvas){finish();return;}
   canvas.font=style.fontWeight+' '+style.fontSize+' '+style.fontFamily;
   const startX=position.x+parseFloat(style.paddingLeft),submit=el.querySelector('button[type="submit"]') as HTMLElement|null,sp=submit?layoutPoint(submit,el):{x:width-40,y:6};
   const fronts=Array.from({length:fullText.length+1},(_,i)=>canvas.measureText(fullText.slice(0,i)).width);
   const g={x:startX+fronts[fronts.length-1],startX,fronts,fullWidth:fronts[fronts.length-1],y:position.y+parseFloat(style.paddingTop),h:parseFloat(style.lineHeight)||20,submitX:sp.x+(submit?.offsetWidth??28)/2,submitY:sp.y+(submit?.offsetHeight??28)/2};
   flushSync(()=>{setPoint(g);callback.current?.(g);});finish();
  });return()=>{active=false;finish();};
 },[fullText,width,kind,handle]);
 useGsapScrub(host,animationFrame??0,(tl,el)=>{
  const form=el.querySelector('form'),header=kind==='home'?el.firstElementChild?.firstElementChild:null,project=el.querySelector('[aria-label^="选择项目"]');
  if(header)tl.fromTo(header,{y:14,opacity:0},{y:0,opacity:1,duration:.55,ease:'power3.out'},at(-20));
  if(form)tl.fromTo(form,{y:22,opacity:0},{y:0,opacity:1,duration:.6,ease:'power3.out'},at(-16));
  if(project)tl.fromTo(project,{x:-15,opacity:0},{x:0,opacity:1,duration:.45,ease:'power2.out'},at(4));
  const submit=el.querySelector('button[type="submit"]')||el.querySelector('form button:last-child');
  if(submit&&clickFrame!==undefined){tl.fromTo(submit,{scale:1},{scale:1.13,duration:.23,ease:'power2.out',transformOrigin:'50% 50%'},at(clickFrame-22));tl.to(submit,{scale:.88,duration:.09,ease:'power2.in'},at(clickFrame));tl.to(submit,{scale:1,duration:.35,ease:'back.out(1.45)'},at(clickFrame+6));}
 },kind+':'+String(clickFrame),animationFrame!==undefined);
 const caretX=point.startX+(point.fronts?.[text.length]??point.fullWidth);
 return <div ref={host} data-openlink-theme="light" className="light" style={{width,position:'relative',background:'transparent'}}>
  {kind==='home'?<FilmCurrentUi><CurrentHomeComposer text={text}/></FilmCurrentUi>:<FilmCurrentUi><CurrentSessionComposer text={text} expanded={false} busy={busy}/></FilmCurrentUi>}
  {caret&&<div style={{position:'absolute',left:caretX+1,top:point.y+1,width:1.5,height:point.h-2,background:'var(--app-foreground)',borderRadius:2}}/>}
 </div>;
}

export function NativeTimeline({f,width=560,height=604,expanded=false,workflowOpen,animationFrame}: {f:number;width?:number;height?:number;expanded?:boolean;workflowOpen?:boolean;animationFrame?:number}) {
 const ref=useRef<HTMLDivElement>(null);
 const events=eventsAt(f).map(e=>e.type==='message.user'?{...e,text:f>=1220?REVISION:PROMPT}:e.type==='message.completed'?{...e,text:f>=1220?'Updated to electric blue. Your layout and project inquiry link are unchanged.':'The Forma landing page is ready to review. Open the preview or inspect the changed files.'}:e);
 const phase=[245,275,365,390,465,480,570,600].filter(n=>f>=n).length+Number(expanded)*10;
 useGsapScrub(ref,animationFrame??0,(tl,el)=>{
  const section=el.querySelector('[data-round-state]');if(!section)return;
  const user=section.firstElementChild;if(user)tl.fromTo(user,{x:28,opacity:0},{x:0,opacity:1,duration:.4,ease:'power2.out'},at(-16));
  const items=Array.from(el.querySelectorAll('[data-slot="collapsible"]'));
  items.slice(0,3).forEach((node,i)=>{const starts=[30,140,260],ends=[100,230,350];tl.fromTo(node,{y:18,opacity:0},{y:0,opacity:1,duration:.42,ease:'power3.out'},at(starts[i]));const icon=node.querySelector('svg');if(icon)tl.fromTo(icon,{scale:.75},{scale:1,duration:.35,ease:'back.out(1.5)',transformOrigin:'50% 50%'},at(ends[i]));});
  const card=el.querySelector('[data-slot="git-snapshot"]') as HTMLElement|null;
  if(card){const reply=el.querySelector('[data-ending-item="summary"]');if(reply)tl.fromTo(reply,{y:18,opacity:0},{y:0,opacity:1,duration:.5,ease:'power2.out'},at(380));tl.fromTo(card,{y:22,opacity:0},{y:0,opacity:1,duration:.45,ease:'power2.out'},at(386));if(expanded){const h=card.scrollHeight;tl.fromTo(card,{height:44},{height:h,duration:.8,ease:'power2.inOut'},at(460));const pre=card.querySelector('pre');if(pre)tl.fromTo(pre,{y:15,opacity:0},{y:0,opacity:1,duration:.45,ease:'power2.out'},at(474));}}
 },phase,animationFrame!==undefined);
 return <div ref={ref} data-openlink-theme="light" className="light" style={{width,height,position:'relative',background:'transparent'}}>
  <FilmState.Provider value={{editing:false,pending:false,draft:PROMPT,changesOpen:expanded,workflowOpen}}>
   <FilmTimelineUi><ChatTimeline events={events} isStreaming={f<600} onFlowStatusChange={undefined} onEditMessage={undefined}/></FilmTimelineUi>
  </FilmState.Provider>
 </div>;
}

export function NativeChanges({animationFrame}: {animationFrame?:number}) {
 const ref=useRef<HTMLDivElement>(null),event=eventsAt(1320).find(e=>e.type==='file.changed');
 useGsapScrub(ref,animationFrame??0,(tl,el)=>{
  const card=el.querySelector('[data-slot="git-snapshot"]'),file=el.querySelector('[aria-pressed]'),code=el.querySelector('pre');
  if(card)tl.fromTo(card,{y:16,opacity:0},{y:0,opacity:1,duration:.5,ease:'power3.out'},at(-18));
  if(file)tl.fromTo(file,{x:-16,opacity:0},{x:0,opacity:1,duration:.4,ease:'power3.out'},at(6));
  if(code)tl.fromTo(code,{y:18,opacity:0},{y:0,opacity:1,duration:.5,ease:'power2.out'},at(20));
 },'diff',animationFrame!==undefined);
 return <div ref={ref} data-openlink-theme="light" className="light" style={{width:560,background:'transparent'}}><FilmState.Provider value={{editing:false,pending:false,draft:'',changesOpen:true,workflowOpen:false}}><FilmTimelineUi><SourceGitSnapshot item={{...event,id:'film-change',kind:'change',label:'Updated the visual theme'}}/></FilmTimelineUi></FilmState.Provider></div>;
}
