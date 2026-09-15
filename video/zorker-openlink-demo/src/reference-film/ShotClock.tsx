import {createContext,useContext} from 'react';
import type {ReactNode} from 'react';
import {useCurrentFrame,useVideoConfig} from 'remotion';
const Clock=createContext<number|null>(null);
export function ShotClock({lead,duration,children}: {lead:number;duration:number;children:ReactNode}) {
 const raw=useCurrentFrame(),{fps}=useVideoConfig(),step=60/fps;
 const f=raw*step;
 void duration;
 return <Clock.Provider value={f-lead}>{children}</Clock.Provider>;
}
export function useShotFrame(){const f=useCurrentFrame(),{fps}=useVideoConfig(),local=useContext(Clock);return local??f*60/fps;}
