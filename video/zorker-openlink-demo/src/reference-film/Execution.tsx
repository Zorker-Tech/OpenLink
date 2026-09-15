import {useShotFrame} from './ShotClock';
import {NativeTimeline} from './Native';
import {Camera,Disclosure,Stage} from './primitives';
import {choreography} from './Choreography';

export function Execution(){
 const f=useShotFrame(),p=choreography('execution',f);
 const state=f<30?245:f<100?300:f<140?370:f<230?420:f<260?470:f<350?520:f<380?590:700;
 return <Stage><Camera x={p.x} y={p.y} scale={p.zoom}><div style={{position:'absolute',left:680,top:400,translate:'0 '+p.actorY+'px'}}><NativeTimeline f={state} expanded={f>=460} workflowOpen animationFrame={f}/></div></Camera>
 <div style={{position:'absolute',left:0,right:0,bottom:0,height:105,background:'linear-gradient(transparent,#fff 90%)'}}/><Disclosure/></Stage>;
}
