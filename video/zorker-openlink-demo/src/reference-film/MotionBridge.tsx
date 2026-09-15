import {AbsoluteFill} from 'remotion';
import type {ReactNode} from 'react';
import type {TransitionPresentationComponentProps} from '@remotion/transitions';
import curves from './motion-curves.json';

export type BridgeKind='forward'|'rise'|'reveal'|'match';
function sample(values:number[],p:number){const v=Math.max(0,Math.min(1,p))*1024,i=Math.floor(v);return values[i]+((values[Math.min(1024,i+1)]??values[i])-values[i])*(v-i);}
export const gsapProgress=(p:number)=>sample(curves.ease,p);
export const motionSettle=(p:number)=>sample(curves.settle,p);

function pose(p:number,entering:boolean,kind:BridgeKind){
 const q=gsapProgress(p),rest=1-motionSettle(p);
 const x=kind==='forward'?(entering?125*(1-q):-155*q):0;
 const y=kind==='rise'?(entering?72*(1-q):-48*q):0;
 const scale=kind==='match'?1:entering?1-.035*rest:1+.025*q;
 return {opacity:entering?q:1,transform:`translate(${x}px,${y}px) scale(${scale})`,transformOrigin:'50% 50%'};
}
export function FilmTransition({children,presentationProgress,presentationDirection,passedProps}:TransitionPresentationComponentProps<{kind:BridgeKind}>){
 return <AbsoluteFill style={pose(presentationProgress,presentationDirection==='entering',passedProps.kind)}>{children}</AbsoluteFill>;
}
export const bridge=(kind:BridgeKind)=>({component:FilmTransition,props:{kind}});

/** Same two-image overlap inside feature scenes; never a conditional one-frame swap. */
export function Blend({progress,kind='forward',before,after}: {progress:number;kind?:BridgeKind;before:ReactNode;after:ReactNode}) {
 if(progress<=0)return <>{before}</>;
 if(progress>=1)return <>{after}</>;
 return <AbsoluteFill><AbsoluteFill style={pose(progress,false,kind)}>{before}</AbsoluteFill><AbsoluteFill style={pose(progress,true,kind)}>{after}</AbsoluteFill></AbsoluteFill>;
}
