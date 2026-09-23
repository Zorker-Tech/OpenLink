import {useLayoutEffect,useRef,useState} from 'react';
import {flushSync} from 'react-dom';
import {continueRender,delayRender} from 'remotion';
import {SourceChatTopbar,SourceInspectorOverlay,SourcePreviewCanvas,SourceTopbar} from './source/preview.js';
import {SampleSite} from '../scenes/SampleSite';
import {NativeTimeline} from './Native';
import {CurrentSessionComposer} from './current-ui/components/film-chat-composer.js';
import {at,layoutPoint,useGsapScrub} from './Choreography';
import {FilmCurrentUi} from './FilmLocale';

export type ProductGeometry={hero:{x:number;y:number;width:number;height:number};inspect:{x:number;y:number};diff:{x:number;y:number};version:{x:number;y:number}};
export function ProductPreview({blue=false,inspect=false,selected=inspect,version=null,paletteProgress,animationFrame,mode='entry',onGeometry}: {blue?:boolean;inspect?:boolean;selected?:boolean;version?:string|null;paletteProgress?:number;animationFrame?:number;mode?:'entry'|'inspect'|'version';onGeometry?:(g:ProductGeometry)=>void}) {
 const root=useRef<HTMLDivElement>(null),callback=useRef(onGeometry);callback.current=onGeometry;
 const [bounds,setBounds]=useState({left:32,top:178,width:290,height:145});
 const [handle]=useState(()=>delayRender('Measure native preview once')),cleared=useRef(false);
 useLayoutEffect(()=>{
  let active=true;const finish=()=>{if(!cleared.current){cleared.current=true;continueRender(handle);}};
  document.fonts.ready.then(()=>{
   const host=root.current,body=host?.querySelector('[data-project-content]') as HTMLElement|null,title=host?.querySelector('.site-title') as HTMLElement|null;
   if(!active||!host||!body||!title){finish();return;}
   const b=layoutPoint(body,host),t=layoutPoint(title,host);
   const next={left:t.x-b.x,top:t.y-b.y,width:title.offsetWidth,height:title.offsetHeight};
   const point=(selector:string,fallback:{x:number;y:number})=>{const el=host.querySelector(selector) as HTMLElement|null;if(!el)return fallback;const p=layoutPoint(el,host);return {x:p.x+el.offsetWidth/2,y:p.y+el.offsetHeight/2};};
   flushSync(()=>{setBounds(next);callback.current?.({hero:{x:t.x,y:t.y,width:title.offsetWidth,height:title.offsetHeight},inspect:point('[aria-label="Select component"]',{x:1160,y:25}),diff:point('[data-slot="git-snapshot"] [aria-label="查看差异"]',{x:340,y:260}),version:point('[aria-label="Switch preview version"]',{x:1240,y:25})});});finish();
  });return()=>{active=false;finish();};
 },[handle,blue]);
 useGsapScrub(root,animationFrame??0,(tl,el)=>{
  if(mode==='entry'){const header=el.querySelector('header'),body=el.querySelector('[data-project-content]'),aside=el.querySelector('aside');if(header)tl.fromTo(header,{y:-18,opacity:0},{y:0,opacity:1,duration:.45,ease:'power3.out'},at(-10));if(aside)tl.fromTo(aside,{x:-18,opacity:0},{x:0,opacity:1,duration:.55,ease:'power3.out'},at(0));if(body)tl.fromTo(body,{y:32,opacity:0},{y:0,opacity:1,duration:.6,ease:'power3.out'},at(6));}
  if(mode==='inspect'){
   for(const [selector,frame]of [['[aria-label="Select component"]',35],['[data-slot="git-snapshot"] [aria-label="查看差异"]',220]] as const){const target=el.querySelector(selector);if(target){tl.fromTo(target,{scale:1},{scale:1.12,duration:.2,ease:'power2.out',transformOrigin:'50% 50%'},at(frame-15));tl.to(target,{scale:.88,duration:.08},at(frame));tl.to(target,{scale:1,duration:.3,ease:'back.out(1.4)'},at(frame+5));}}
   const selection=el.querySelector('[data-film-selection]'),label=selection?.querySelector('span');if(selection)tl.fromTo(selection,{opacity:0},{opacity:1,duration:.25,ease:'power2.out'},at(75));if(label)tl.fromTo(label,{y:8,opacity:0},{y:0,opacity:1,duration:.3,ease:'power3.out'},at(78));
  }
  if(mode==='version'){const target=el.querySelector('[aria-label="Switch preview version"]');if(target)tl.fromTo(target,{backgroundColor:'#ebebeb'},{backgroundColor:'rgba(0,0,0,0)',duration:1,ease:'sine.out'},at(160));}
 },mode+':'+Number(selected),animationFrame!==undefined);
 return <div ref={root} data-openlink-theme="light" data-theme="light" className="light" style={{position:'relative',width:1440,height:900,overflow:'hidden',background:'var(--app-background)',borderRadius:10,boxShadow:'0 20px 80px #00000018',border:'1px solid var(--app-control-border)'}}>
  <SourceTopbar/>
  <div style={{display:'flex',height:850}}>
   <aside style={{width:390,flexShrink:0,borderRight:'1px solid var(--app-border)',display:'flex',flexDirection:'column',overflow:'hidden'}}>
    <SourceChatTopbar title="Forma · Landing page"/>
    <div style={{flex:1,minHeight:0,overflow:'hidden'}}><NativeTimeline f={blue?1320:700} width={390} height={742}/></div>
    <FilmCurrentUi><div style={{padding:8}}><CurrentSessionComposer text=""/></div></FilmCurrentUi>
   </aside>
   <div style={{flex:1,minWidth:0}}><SourcePreviewCanvas inspect={inspect} selectedGitRef={version}><div data-project-content style={{position:'relative',height:'100%'}}><SampleSite blue={blue} paletteProgress={paletteProgress}/>{selected&&<div data-film-selection style={{position:'absolute',inset:0,pointerEvents:'none'}}><SourceInspectorOverlay bounds={bounds} label="Hero · app/page.tsx"/></div>}</div></SourcePreviewCanvas></div>
  </div>
 </div>;
}
