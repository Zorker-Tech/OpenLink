import {Img,staticFile} from 'remotion';
import {useShotFrame} from './ShotClock';
import {Brand,Stage,move,reveal} from './primitives';

// Logo-only opening: no spheres, particles, or optical blur.
export function Genesis() {
 const f=useShotFrame();
 return <Stage>
  <div style={{position:'absolute',left:850,top:434,width:220,height:132,opacity:reveal(f,0,28)*(1-reveal(f,85,135)),translate:`${move(f,62,134,0,-215)}px 0`,scale:move(f,0,60,1.3,1)-move(f,62,134,0,.68),transformOrigin:'50% 50%'}}>
   <Img src={staticFile('brand/zorker-logo-dark.svg')} style={{width:220,height:132}}/>
  </div>
  <div style={{position:'absolute',left:0,right:0,top:475,opacity:reveal(f,98,146),translate:`0 ${move(f,98,146,12,0)}px`}}><Brand size={58}/></div>
 </Stage>;
}
