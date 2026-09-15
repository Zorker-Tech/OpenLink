import {useLayoutEffect,useRef} from 'react';
import type {RefObject} from 'react';
import {gsap} from 'gsap';
import tracks from './choreography.json';
import {gsapProgress} from './MotionBridge';

export type Pose={x:number;y:number;zoom:number;actorY:number;actorScale:number;focus?:number;track?:number;send?:number};
export function choreography(name:keyof typeof tracks,f:number):Pose{
 const t=tracks[name],index=Math.max(0,Math.min(t.samples.length-1,(f-t.start)/t.step)),i=Math.floor(index),a=t.samples[i] as Pose,b=t.samples[Math.min(i+1,t.samples.length-1)] as Pose;
 return Object.fromEntries(Object.keys(a).map(k=>[k,a[k as keyof Pose]!+(b[k as keyof Pose]!-a[k as keyof Pose]!)*(index-i)])) as Pose;
}
export const at=(f:number)=>(f+32)/60;
type Builder=(timeline:gsap.core.Timeline,host:HTMLElement)=>void;
export function useGsapScrub(ref:RefObject<HTMLElement|null>,frame:number,builder:Builder,key:string|number,active=true){
 const tl=useRef<gsap.core.Timeline|null>(null),build=useRef(builder);build.current=builder;
 useLayoutEffect(()=>{
  if(!active||!ref.current)return;
  const context=gsap.context(()=>{tl.current=gsap.timeline({paused:true,defaults:{force3D:false}});build.current(tl.current!,ref.current!);},ref.current);
  gsap.ticker.sleep();return()=>{tl.current?.kill();tl.current=null;context.revert();};
 },[ref,key,active]);
 useLayoutEffect(()=>{tl.current?.totalTime(Math.max(0,at(frame)),true);gsap.ticker.sleep();},[frame,key,active]);
}
export function arcPoint(from:[number,number],to:[number,number],progress:number,bend=75):[number,number]{
 const p=gsapProgress(progress),mx=(from[0]+to[0])/2,my=(from[1]+to[1])/2-bend;
 return [(1-p)**2*from[0]+2*(1-p)*p*mx+p*p*to[0],(1-p)**2*from[1]+2*(1-p)*p*my+p*p*to[1]];
}
export function ClickPulse({x,y,f,start}:{x:number;y:number;f:number;start:number}){
 const p=Math.max(0,Math.min(1,(f-start)/24));if(f<start||p>=1)return null;
 return <div style={{position:'absolute',left:x-34,top:y-34,width:68,height:68,border:'2px solid #858c95',borderRadius:'50%',opacity:.45*(1-p),scale:.55+1.5*p,pointerEvents:'none'}}/>;
}
export function layoutPoint(element:HTMLElement,root:HTMLElement){
 let x=0,y=0,node:HTMLElement|null=element;
 while(node&&node!==root){x+=node.offsetLeft;y+=node.offsetTop;const parent=node.offsetParent as HTMLElement|null;if(parent&&parent!==root){x+=parent.clientLeft;y+=parent.clientTop;}node=parent;}
 return {x,y};
}
