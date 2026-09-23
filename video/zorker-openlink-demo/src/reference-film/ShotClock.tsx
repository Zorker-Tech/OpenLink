import {createContext,useContext} from 'react';
import type {ReactNode} from 'react';
import {useCurrentFrame,useVideoConfig} from 'remotion';
const Clock=createContext<number|null>(null);
export function ShotClock({lead,duration,playbackFrames=duration,children}: {lead:number;duration:number;playbackFrames?:number;children:ReactNode}) {
 const raw=useCurrentFrame(),{fps}=useVideoConfig(),step=60/fps;
 // Keep the authored GSAP/Motion timeline in its original 60fps frame domain,
 // while allowing the director's cut to play each scene over fewer output frames.
 const f=raw*step*duration/playbackFrames;
 return <Clock.Provider value={f-lead}>{children}</Clock.Provider>;
}
export function useShotFrame(){const f=useCurrentFrame(),{fps}=useVideoConfig(),local=useContext(Clock);return local??f*60/fps;}
