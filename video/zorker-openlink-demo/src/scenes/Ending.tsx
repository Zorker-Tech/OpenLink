import {AbsoluteFill,Img,staticFile,useCurrentFrame,interpolate} from 'remotion';
export const Ending=()=>{
 const f=useCurrentFrame();
 return <AbsoluteFill style={{background:'#101111',color:'#f5f5f1',alignItems:'center',justifyContent:'center'}}>
  <div style={{display:'flex',alignItems:'center',gap:34,opacity:interpolate(f,[0,16],[0,1],{extrapolateRight:'clamp'})}}>
   <Img src={staticFile('brand/zorker-light.svg')} style={{width:320,height:104,objectFit:'contain'}}/>
   <span style={{fontSize:60,letterSpacing:-2}}>OpenLink</span>
  </div>
  <div style={{position:'absolute',bottom:48,fontSize:15,color:'#757974'}}>Illustrative workflow · Demo data · Time compressed</div>
 </AbsoluteFill>;
};
