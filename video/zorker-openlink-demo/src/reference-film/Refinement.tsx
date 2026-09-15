import {useState} from 'react';
import {NativePrompt,REVISION,type PromptGeometry} from './Native';
import {Camera,Cursor,Disclosure,Stage} from './primitives';
import {useShotFrame} from './ShotClock';
import {arcPoint,choreography,ClickPulse} from './Choreography';

export function Refinement(){
 const f=useShotFrame(),p=choreography('refinement',f),count=Math.floor(Math.max(0,Math.min(REVISION.length,(f-30)/162*REVISION.length)));
 const [g,setG]=useState<PromptGeometry>({x:36,y:11,h:20,startX:36,fullWidth:240,submitX:677,submitY:21,fronts:[]});
 const wx=610,wy=519,fx=960+(wx+g.startX+g.fullWidth/2-960)*(p.focus??0),fy=540+(wy+g.y+g.h/2-540)*(p.focus??0);
 const x=fx+(wx+g.submitX-fx)*(p.send??0),y=fy+(wy+g.submitY-fy)*(p.send??0);
 const sx=960+(wx+g.submitX-x)*p.zoom,sy=540+(wy+g.submitY-y)*p.zoom,cursor=arcPoint([1330,820],[sx-8,sy-6],(f-260)/48,90);
 return <Stage><Camera x={x} y={y} scale={p.zoom}><div style={{position:'absolute',left:wx,top:wy,translate:'0 '+p.actorY+'px',scale:p.actorScale}}><NativePrompt kind="chat" text={f>=324?'':REVISION.slice(0,count)} fullText={REVISION} caret={f>=30&&f<220} busy={f>=324} onGeometry={setG} animationFrame={f} clickFrame={312}/></div></Camera>
 <Cursor x={cursor[0]} y={cursor[1]} opacity={f>=250&&f<350?Math.min(1,(f-250)/15,(350-f)/18):0} pressed={f>=312&&f<318?(f-312)/6:f>=318&&f<330?1-(f-318)/12:0}/>
 <ClickPulse x={sx} y={sy} f={f} start={312}/><Disclosure/></Stage>;
}
