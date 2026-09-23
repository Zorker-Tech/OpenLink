import {useState} from 'react';
import {NativePrompt,PROMPT,frontAt,type PromptGeometry} from './Native';
import {Camera,Cursor,Disclosure,Stage} from './primitives';
import {useShotFrame} from './ShotClock';
import {arcPoint,choreography,ClickPulse} from './Choreography';

export function Intent(){
 const f=useShotFrame(),p=choreography('intent',f),typed=Math.max(0,Math.min(PROMPT.length,(f-50)/300*PROMPT.length));
 const [g,setG]=useState<PromptGeometry>({x:16,y:50,h:20,startX:16,fullWidth:410,submitX:675,submitY:136,fronts:[]});
 const wx=610,wy=443,center=wx+g.startX+g.fullWidth/2,front=wx+g.startX+frontAt(g,typed);
 const focus=960+(center-960)*(p.focus??0)+(front-center)*(p.track??0);
 const x=focus+(wx+g.submitX-focus)*(p.send??0),baseY=540+(wy+g.y+g.h/2-540)*(p.focus??0),y=baseY+(wy+g.submitY-baseY)*(p.send??0);
 const sx=960+(wx+g.submitX-x)*p.zoom,sy=540+(wy+g.submitY-y)*p.zoom;
 const cursor=arcPoint([1370,850],[sx-8,sy-6],(f-345)/57,120);
 return <Stage><Camera x={x} y={y} scale={p.zoom}><div style={{position:'absolute',left:wx,top:wy,translate:'0 '+p.actorY+'px',scale:p.actorScale,transformOrigin:'50% 50%'}}><NativePrompt kind="home" text={PROMPT.slice(0,Math.floor(typed))} fullText={PROMPT} caret={f>=50&&f<360} onGeometry={setG} animationFrame={f} clickFrame={405}/></div></Camera>
 <Cursor x={cursor[0]} y={cursor[1]} opacity={f>=335&&f<460?Math.min(1,(f-335)/15,(460-f)/20):0} pressed={f>=405&&f<411?(f-405)/6:f>=411&&f<425?1-(f-411)/14:0}/>
 <ClickPulse x={sx} y={sy} f={f} start={405}/><Disclosure/></Stage>;
}
