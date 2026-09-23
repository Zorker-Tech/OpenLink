import {useEffect,useState} from 'react';
import {AbsoluteFill,continueRender,delayRender,staticFile,useVideoConfig} from 'remotion';
import {Audio} from '@remotion/media';
import {TransitionSeries,linearTiming} from '@remotion/transitions';
import {ShotClock} from './ShotClock';
import {bridge} from './MotionBridge';
import type {BridgeKind} from './MotionBridge';
import {Genesis} from './Genesis';
import {Intent} from './Intent';
import {Execution} from './Execution';
import {Artifact} from './Artifact';
import {Refinement} from './Refinement';
import {Resolution} from './Resolution';
import {Finale} from './Finale';
import {Features} from './Features';
import storyboard from './storyboard-v10.json';

export function ReferenceFilm() {
 const {width,fps}=useVideoConfig();
 const F=(n:number)=>Math.round(n*fps/60);
 const shot=Object.fromEntries(storyboard.shots.map(s=>[s.id,s])) as Record<string,(typeof storyboard.shots)[number]>;
 const cut=storyboard.transitions as Array<{kind:BridgeKind;frames:number}>;
 const [fontHandle]=useState(()=>delayRender('Load local brand font'));
 useEffect(()=>{document.fonts.load('500 32px OpenLinkGeist').then(()=>continueRender(fontHandle));},[fontHandle]);
 return <AbsoluteFill className="film reference-film" style={{background:'#ffffff',fontFamily:'OpenLinkGeist, sans-serif'}}>
  <Audio src={staticFile('audio/openlink-keyboard-sfx.wav')}/>
  <div style={{position:'absolute',width:1920,height:1080,zoom:width/1920,overflow:'hidden',pointerEvents:'none'}}>
   <TransitionSeries>
    <TransitionSeries.Sequence name={shot.logo.title} durationInFrames={F(shot.logo.sequenceFrames)}><ShotClock lead={shot.logo.sourceLead} duration={shot.logo.sourceFrames} playbackFrames={shot.logo.activeFrames}><Genesis/></ShotClock></TransitionSeries.Sequence>
    <TransitionSeries.Transition presentation={bridge(cut[0].kind)} timing={linearTiming({durationInFrames:F(cut[0].frames)})}/>
    <TransitionSeries.Sequence name={shot.prompt.title} durationInFrames={F(shot.prompt.sequenceFrames)}><ShotClock lead={shot.prompt.sourceLead} duration={shot.prompt.sourceFrames} playbackFrames={shot.prompt.activeFrames}><Intent/></ShotClock></TransitionSeries.Sequence>
    <TransitionSeries.Transition presentation={bridge(cut[1].kind)} timing={linearTiming({durationInFrames:F(cut[1].frames)})}/>
    <TransitionSeries.Sequence name={shot.work.title} durationInFrames={F(shot.work.sequenceFrames)}><ShotClock lead={shot.work.sourceLead} duration={shot.work.sourceFrames} playbackFrames={shot.work.activeFrames}><Execution/></ShotClock></TransitionSeries.Sequence>
    <TransitionSeries.Transition presentation={bridge(cut[2].kind)} timing={linearTiming({durationInFrames:F(cut[2].frames)})}/>
    <TransitionSeries.Sequence name={shot.workspace.title} durationInFrames={F(shot.workspace.sequenceFrames)}><ShotClock lead={shot.workspace.sourceLead} duration={shot.workspace.sourceFrames} playbackFrames={shot.workspace.activeFrames}><Artifact/></ShotClock></TransitionSeries.Sequence>
    <TransitionSeries.Transition presentation={bridge(cut[3].kind)} timing={linearTiming({durationInFrames:F(cut[3].frames)})}/>
    <TransitionSeries.Sequence name={shot.refine.title} durationInFrames={F(shot.refine.sequenceFrames)}><ShotClock lead={shot.refine.sourceLead} duration={shot.refine.sourceFrames} playbackFrames={shot.refine.activeFrames}><Refinement/></ShotClock></TransitionSeries.Sequence>
    <TransitionSeries.Transition presentation={bridge(cut[4].kind)} timing={linearTiming({durationInFrames:F(cut[4].frames)})}/>
    <TransitionSeries.Sequence name={shot.result.title} durationInFrames={F(shot.result.sequenceFrames)}><ShotClock lead={shot.result.sourceLead} duration={shot.result.sourceFrames} playbackFrames={shot.result.activeFrames}><Resolution/></ShotClock></TransitionSeries.Sequence>
    <TransitionSeries.Transition presentation={bridge(cut[5].kind)} timing={linearTiming({durationInFrames:F(cut[5].frames)})}/>
    <TransitionSeries.Sequence name={shot.proof.title} durationInFrames={F(shot.proof.sequenceFrames)}><ShotClock lead={shot.proof.sourceLead} duration={shot.proof.sourceFrames} playbackFrames={shot.proof.activeFrames}><Features/></ShotClock></TransitionSeries.Sequence>
    <TransitionSeries.Transition presentation={bridge(cut[6].kind)} timing={linearTiming({durationInFrames:F(cut[6].frames)})}/>
    <TransitionSeries.Sequence name={shot.close.title} durationInFrames={F(shot.close.sequenceFrames)}><ShotClock lead={shot.close.sourceLead} duration={shot.close.sourceFrames} playbackFrames={shot.close.activeFrames}><Finale/></ShotClock></TransitionSeries.Sequence>
   </TransitionSeries>
  </div>
 </AbsoluteFill>;
}
