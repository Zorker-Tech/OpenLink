import {AbsoluteFill, Img, staticFile, useCurrentFrame, interpolate, Easing} from 'remotion';
export const Intro=()=>{
  const f=useCurrentFrame();
  return <AbsoluteFill style={{background:'#101111',color:'#f5f5f1',padding:'86px 120px'}}>
    <div style={{display:'flex',alignItems:'center',gap:24,opacity:interpolate(f,[0,24],[0,1],{extrapolateRight:'clamp'})}}>
      <Img src={staticFile('brand/zorker-light.svg')} style={{width:196,height:60,objectFit:'contain'}} />
      <span style={{width:1,height:33,background:'#555'}}/><span style={{fontSize:29,letterSpacing:'.5px'}}>OpenLink</span>
    </div>
    <div style={{position:'absolute',left:120,top:365,opacity:interpolate(f,[18,42],[0,1],{extrapolateLeft:'clamp',extrapolateRight:'clamp'}),translate:`0 ${interpolate(f,[18,55],[30,0],{extrapolateLeft:'clamp',extrapolateRight:'clamp',easing:Easing.bezier(.16,1,.3,1)})}px`}}>
      <div className="eyebrow" style={{marginBottom:28}}>THE AGENT WORKSPACE</div>
      <h1 style={{fontSize:112,fontWeight:500,letterSpacing:-6,lineHeight:1.06}}>From an idea.<br/><span style={{color:'#bcbdb7'}}>Into a working project.</span></h1>
    </div>
    <Img src={staticFile('brand/zorker-logo-light.svg')} style={{position:'absolute',right:115,top:370,width:345,height:225,objectFit:'contain',opacity:interpolate(f,[34,70],[0,.85],{extrapolateLeft:'clamp',extrapolateRight:'clamp'})}}/>
    <div style={{position:'absolute',bottom:88,left:120,right:120,display:'flex',justifyContent:'space-between',fontSize:21,color:'#8e918c',borderTop:'1px solid #353735',paddingTop:22}}><span>ZORKER OPENLINK</span><span>PRODUCT DEMO / 01</span></div>
    <AbsoluteFill style={{background:'#f4f4f1',opacity:interpolate(f,[135,149],[0,1],{extrapolateLeft:'clamp',extrapolateRight:'clamp'})}}/>
  </AbsoluteFill>;
};
