import {useRef,useState} from 'react';
import {ProductPreview,type ProductGeometry} from './ProductPreview';
import {NativeChanges} from './Native';
import {SourceVersionMenu} from './source/preview.js';
import {Camera,Cursor,Disclosure,Stage} from './primitives';
import {useShotFrame} from './ShotClock';
import {Blend,gsapProgress} from './MotionBridge';
import {arcPoint,at,choreography,ClickPulse,useGsapScrub} from './Choreography';

function InspectFeature({f}:{f:number}){
 const p=choreography('inspector',f),[g,setG]=useState<ProductGeometry>({hero:{x:422,y:190,width:290,height:145},inspect:{x:1160,y:25},diff:{x:340,y:260},version:{x:1240,y:25}});
 const world=(point:{x:number;y:number}):[number,number]=>[240+point.x,90+point.y];
 const screen=(point:[number,number]):[number,number]=>[960+(point[0]-p.x)*p.zoom,540+(point[1]-p.y)*p.zoom];
 const ip=world(g.inspect),hp=world({x:g.hero.x+g.hero.width*.4,y:g.hero.y+g.hero.height*.45}),dp=world(g.diff);
 let pointer:[number,number];
 if(f<35)pointer=arcPoint([1450,840],screen(ip),(f+5)/40,130);
 else if(f<75)pointer=screen(arcPoint(ip,hp,(f-35)/40,70));
 else if(f<145)pointer=screen(hp);
 else pointer=screen(arcPoint(hp,dp,(f-145)/65,-55));
 const click=f<65?35:f<160?75:220,cp=screen(f<65?ip:f<160?hp:dp);
 return <Stage><Camera x={p.x} y={p.y} scale={p.zoom}><div style={{position:'absolute',left:240,top:90}}><ProductPreview blue inspect={f>=35} selected={f>=75} animationFrame={f} mode="inspect" onGeometry={setG}/></div></Camera>
 <Cursor x={pointer[0]-8} y={pointer[1]-6} opacity={f>-5&&f<256?Math.min(1,(f+5)/15,(256-f)/20):0} pressed={f>=click&&f<click+6?(f-click)/6:f>=click+6&&f<click+18?1-(f-click-6)/12:0}/>
 <ClickPulse x={cp[0]} y={cp[1]} f={f} start={click}/><Disclosure/></Stage>;
}
function DiffFeature({f}:{f:number}){
 const p=choreography('diff',f),pointer=arcPoint([1260,830],[630,480],(f-45)/65,90);
 return <Stage><div style={{position:'absolute',left:288,top:315+p.actorY,scale:2.4,transformOrigin:'0 0'}}><div style={{width:560,scale:p.actorScale,transformOrigin:'50% 50%'}}><NativeChanges animationFrame={f}/></div></div>
 <Cursor x={pointer[0]} y={pointer[1]} opacity={f>=40&&f<160?Math.min(1,(f-40)/18,(160-f)/24):0}/><Disclosure/></Stage>;
}
function VersionsFeature({f}:{f:number}){
 const p=choreography('versions',f),ref=useRef<HTMLDivElement>(null),cursor=arcPoint([1380,810],[955,552],(f-55)/70,110);
 useGsapScrub(ref,f,(tl,el)=>{
  const rows=Array.from(el.querySelectorAll('button'));tl.fromTo(rows,{x:28,opacity:0},{x:0,opacity:1,duration:.42,stagger:.08,ease:'power3.out'},at(-3));
  const target=rows.at(-1);if(target){tl.fromTo(target,{backgroundColor:'rgba(0,0,0,0)'},{backgroundColor:'#ebebeb',duration:.3},at(105));tl.fromTo(target,{scale:1},{scale:.97,duration:.1,transformOrigin:'50% 50%'},at(132));tl.to(target,{scale:1,duration:.24,ease:'back.out(1.3)'},at(138));}
 },'menu',f<180);
 const menu=<Stage><div style={{position:'absolute',left:572,top:245+p.actorY,scale:2.7,transformOrigin:'0 0'}}><div ref={ref} style={{width:280,scale:p.actorScale,transformOrigin:'50% 50%',background:'transparent'}} data-openlink-theme="light" className="light"><SourceVersionMenu selectedGitRef={f>=132?'b7401a8':null}/></div></div><Cursor x={cursor[0]} y={cursor[1]} opacity={f>=45&&f<163?Math.min(1,(f-45)/15,(163-f)/20):0} pressed={f>=132&&f<144?Math.sin((f-132)/12*Math.PI):0}/><ClickPulse x={963} y={558} f={f} start={132}/><Disclosure/></Stage>;
 const q=gsapProgress((f-142)/48);
 const preview=<Stage><div style={{position:'absolute',left:240,top:90+(1-q)*65,scale:(.96+.04*q)*p.actorScale,transformOrigin:'50% 50%'}}><ProductPreview version="b7401a8" animationFrame={f} mode="version"/></div><Disclosure/></Stage>;
 return <Blend progress={(f-140)/36} kind="rise" before={menu} after={preview}/>;
}
export function Features(){const f=useShotFrame();
 if(f<258)return <Blend progress={(f-222)/36} kind="reveal" before={<InspectFeature f={f}/>} after={<DiffFeature f={f-240}/>}/>;
 return <Blend progress={(f-462)/36} kind="forward" before={<DiffFeature f={f-240}/>} after={<VersionsFeature f={f-480}/>}/>;
}
