import {Img,staticFile} from 'remotion';
import {useShotFrame} from './ShotClock';
import {Brand,Stage,move,reveal} from './primitives';

export function Finale() {
 const f=useShotFrame();
 return <Stage>
  <div style={{position:'absolute',left:850,top:390,opacity:(1-reveal(f,105,151)),scale:move(f,0,122,2.4,.75)}}>
   <Img src={staticFile('brand/zorker-logo-dark.svg')} style={{width:220,height:132}}/>
  </div>
  <div style={{position:'absolute',left:0,right:0,top:456,opacity:reveal(f,120,165),translate:`0 ${move(f,120,170,20,0)}px`}}><Brand size={66} subtitle/></div>
 </Stage>;
}
