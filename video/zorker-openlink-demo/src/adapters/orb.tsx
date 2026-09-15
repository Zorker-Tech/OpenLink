import {useLayoutEffect,useRef} from 'react';
import {useCurrentFrame,useVideoConfig} from 'remotion';
import {resolvePreset} from '../source-snapshot/components/thinking/src/presets.js';
import {MODE_DRAWS} from '../source-snapshot/components/thinking/src/engine/registry.js';
import type {CSSProperties} from 'react';
export function ThinkingOrb({state='working',size=64,style,...rest}:{state?:string;size?:number;style?:CSSProperties;className?:string;'aria-label'?:string}) {
 const ref=useRef<HTMLCanvasElement>(null),frame=useCurrentFrame(),{fps,width}=useVideoConfig();
 const density=width>=3840?8:2;
 useLayoutEffect(()=>{
  const canvas=ref.current;if(!canvas)return;
  canvas.width=size*density;canvas.height=size*density;
  const ctx=canvas.getContext('2d');if(!ctx)return;
  const preset=resolvePreset(state,size);
  ctx.setTransform(density,0,0,density,0,0);ctx.clearRect(0,0,size,size);
  MODE_DRAWS[preset.mode as keyof typeof MODE_DRAWS](ctx,size,frame/fps*preset.speed,false,preset.opts);
 },[frame,fps,state,size,density]);
 return <canvas ref={ref} role="img" aria-label={state} style={{width:size,height:size,display:'block',...style}} {...rest}/>;
}
