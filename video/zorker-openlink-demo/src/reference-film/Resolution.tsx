import {useShotFrame} from './ShotClock';
import {ProductPreview} from './ProductPreview';
import {Camera,Disclosure,Stage} from './primitives';
import {choreography} from './Choreography';
import {gsapProgress} from './MotionBridge';
export function Resolution(){
 const f=useShotFrame(),p=choreography('resolution',f),color=gsapProgress((f-20)/80);
 return <Stage><Camera x={p.x} y={p.y} scale={p.zoom}><div style={{position:'absolute',left:240,top:90}}><ProductPreview blue paletteProgress={color}/></div></Camera><Disclosure/></Stage>;
}
