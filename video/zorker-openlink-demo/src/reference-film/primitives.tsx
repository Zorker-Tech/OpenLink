import {AbsoluteFill, Easing, Img, interpolate, staticFile} from 'remotion';
import type {CSSProperties, ReactNode} from 'react';

export const BG = '#ffffff';
export const FG = '#171717';
export const clamp = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'} as const;
export const ease = Easing.bezier(.22, 1, .36, 1);
export const smooth = Easing.bezier(.65, 0, .35, 1);
export const move = (f: number, a: number, b: number, x = 0, y = 1) => interpolate(f, [a,b], [x,y], {...clamp,easing:smooth});
export const reveal = (f: number, a: number, b: number) => interpolate(f,[a,b],[0,1],{...clamp,easing:ease});

export function Stage({children,style}: {children:ReactNode;style?:CSSProperties}) {
 return <AbsoluteFill style={{background:BG,color:FG,overflow:'hidden',...style}}>{children}</AbsoluteFill>;
}
export function Camera({x=960,y=540,scale=1,anchorX=960,anchorY=540,children}: {x?:number;y?:number;scale?:number;anchorX?:number;anchorY?:number;children:ReactNode}) {
 return <div style={{position:'absolute',width:1920,height:1080,transformOrigin:'0 0',transform:`translate(${anchorX-scale*x}px,${anchorY-scale*y}px) scale(${scale})`}}>{children}</div>;
}
export function Brand({size=64,subtitle=false}: {size?:number;subtitle?:boolean}) {
 return <div style={{display:'flex',flexDirection:'column',alignItems:'center',gap:26}}>
  <div style={{display:'flex',alignItems:'center',gap:size*.3,whiteSpace:'nowrap'}}>
   <Img src={staticFile('brand/zorker-logo-dark.svg')} style={{width:size*1.15,height:size*.9,objectFit:'contain'}}/>
   <span style={{fontSize:size,fontWeight:610,letterSpacing:-size*.045}}>Zorker <span style={{fontWeight:390,color:'#55585c'}}>OpenLink</span></span>
  </div>
  {subtitle&&<div style={{fontSize:29,fontWeight:400,color:'#6e7277',letterSpacing:-.5}}>From intent to something real.</div>}
 </div>;
}
export function Cursor({x,y,opacity=1,pressed=0}: {x:number;y:number;opacity?:number;pressed?:number}) {
 return <svg width="76" height="90" viewBox="0 0 76 90" style={{position:'absolute',left:x,top:y,opacity,scale:1-.12*pressed,transformOrigin:'8px 6px',filter:'drop-shadow(0 3px 4px #0009)'}}>
  <path d="M8 6 L15 71 L31 53 L47 77 L59 69 L43 46 L67 41 Z" fill="#171819" stroke="#f6f6f3" strokeWidth="4.2" strokeLinejoin="round"/>
 </svg>;
}
export function Disclosure() {
 return <div style={{position:'absolute',bottom:42,left:64,fontSize:21,color:'#777b80',letterSpacing:.3}}>Illustrative workflow · Time compressed</div>;
}
export function Caption({children,f,at=0,top=145,size=70}: {children:ReactNode;f:number;at?:number;top?:number;size?:number}) {
 const p=reveal(f,at,at+40);
 return <div style={{position:'absolute',left:0,right:0,top,textAlign:'center',fontSize:size,fontWeight:430,letterSpacing:-size*.048,lineHeight:1.05,opacity:p,translate:`0 ${(1-p)*30}px`}}>{children}</div>;
}
