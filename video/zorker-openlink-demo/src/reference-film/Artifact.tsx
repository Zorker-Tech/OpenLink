import {useShotFrame} from './ShotClock';
import {ProductPreview} from './ProductPreview';
import {Camera,Disclosure,Stage} from './primitives';
import {choreography} from './Choreography';
export function PreviewPanel({blue=false}:{blue?:boolean}){return <ProductPreview blue={blue}/>;}
export function Artifact(){
 const f=useShotFrame(),p=choreography('artifact',f);
 return <Stage><Camera x={p.x} y={p.y} scale={p.zoom}><div style={{position:'absolute',left:240,top:90,translate:'0 '+p.actorY+'px',scale:p.actorScale,transformOrigin:'50% 50%'}}><ProductPreview animationFrame={f}/></div></Camera><Disclosure/></Stage>;
}
