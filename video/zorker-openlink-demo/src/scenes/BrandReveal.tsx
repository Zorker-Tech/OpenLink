import {useEffect,useState} from 'react';
import {AbsoluteFill,Easing,Img,interpolate,staticFile,useCurrentFrame,delayRender,continueRender,cancelRender} from 'remotion';
const ease={extrapolateLeft:'clamp',extrapolateRight:'clamp',easing:Easing.bezier(.65,0,.35,1)} as const;
const words=['Imagine.','Create.','OpenLink'];
export function BrandReveal() {
 const f=useCurrentFrame()*150/90;
 const [handle]=useState(()=>delayRender('Measure actual Geist glyphs'));
 const [positions,setPositions]=useState<number[][]>([]);
 useEffect(()=>{
  document.fonts.load('500 132px OpenLinkGeist').then(()=>{
   const context=document.createElement('canvas').getContext('2d');
   if(!context)throw Error('Cannot measure brand typography');
   context.font='500 132px OpenLinkGeist';
   setPositions(words.map(word=>Array.from({length:8},(_,i)=>context.measureText(word.slice(0,i)).width-Math.min(i,word.length)*6)));
   continueRender(handle);
  }).catch(cancelRender);
 },[handle]);
 if(!positions.length)return null;
 return <AbsoluteFill style={{background:'#101111',color:'#f5f5f1'}}>
  <div style={{position:'absolute',left:118,top:384,height:170,fontSize:132,fontWeight:500,letterSpacing:-6}}>
   {Array.from(words[2]).map((_,i)=>{
    const p=interpolate(f,[12+i*.9,29+i*.9],[0,1],ease);
    const q=interpolate(f,[49+i*.9,70+i*.9],[0,1],ease);
    const x=interpolate(q,[0,1],[interpolate(p,[0,1],[positions[0][i],positions[1][i]]),positions[2][i]]);
    const turn=p<1?p:q;
    const word=q>=.5?2:p>=.5?1:0;
    return <span key={i} style={{position:'absolute',left:x,top:0,width:160,height:170,whiteSpace:'pre',transformOrigin:'50% 75%',scale:`1 ${Math.abs(Math.cos(Math.PI*turn))}`,opacity:Math.abs(turn-.5)<.025?0:1,color:word===1?'#bbbdb7':'#f5f5f1'}}>{words[word][i]??''}</span>;
   })}
  </div>
  <Img src={staticFile('brand/zorker-logo-light.svg')} style={{position:'absolute',right:170,top:372,width:322,height:214,objectFit:'contain',opacity:interpolate(f,[54,86],[0,1],ease),scale:interpolate(f,[54,100],[.92,1],ease)}}/>
  <AbsoluteFill style={{background:'#fff',clipPath:`inset(${100*(1-interpolate(f,[126,149],[0,1],ease))}% 0 0 0)`}}/>
 </AbsoluteFill>;
};
