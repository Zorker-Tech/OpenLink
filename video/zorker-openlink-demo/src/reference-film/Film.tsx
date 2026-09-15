import {useEffect,useState} from 'react';
import {AbsoluteFill,continueRender,delayRender,staticFile,useVideoConfig} from 'remotion';
import {Audio} from '@remotion/media';
import {TransitionSeries,linearTiming} from '@remotion/transitions';
import {ShotClock} from './ShotClock';
import {bridge} from './MotionBridge';
import {Genesis} from './Genesis';
import {Intent} from './Intent';
import {Execution} from './Execution';
import {Artifact} from './Artifact';
import {Refinement} from './Refinement';
import {Resolution} from './Resolution';
import {Finale} from './Finale';
import {Features} from './Features';

export function ReferenceFilm() {
 const {width,fps}=useVideoConfig();
 const F=(n:number)=>Math.round(n*fps/60);
 const [fontHandle]=useState(()=>delayRender('Load local brand font'));
 useEffect(()=>{document.fonts.load('500 32px OpenLinkGeist').then(()=>continueRender(fontHandle));},[fontHandle]);
 return <AbsoluteFill className="film reference-film" style={{background:'#ffffff',fontFamily:'OpenLinkGeist, sans-serif'}}>
  <Audio src={staticFile('audio/openlink-keyboard-sfx.wav')}/>
  <div style={{position:'absolute',width:1920,height:1080,zoom:width/1920,overflow:'hidden',pointerEvents:'none'}}>
   <TransitionSeries>
    <TransitionSeries.Sequence name="01 · Logo reveal" durationInFrames={F(198)}><ShotClock lead={0} duration={180}><Genesis/></ShotClock></TransitionSeries.Sequence>
    <TransitionSeries.Transition presentation={bridge('rise')} timing={linearTiming({durationInFrames:F(36)})}/>
    <TransitionSeries.Sequence name="02 · Current home composer" durationInFrames={F(514)}><ShotClock lead={18} duration={480}><Intent/></ShotClock></TransitionSeries.Sequence>
    <TransitionSeries.Transition presentation={bridge('forward')} timing={linearTiming({durationInFrames:F(32)})}/>
    <TransitionSeries.Sequence name="03 · Complete execution" durationInFrames={F(698)}><ShotClock lead={16} duration={660}><Execution/></ShotClock></TransitionSeries.Sequence>
    <TransitionSeries.Transition presentation={bridge('reveal')} timing={linearTiming({durationInFrames:F(44)})}/>
    <TransitionSeries.Sequence name="04 · Native preview" durationInFrames={F(400)}><ShotClock lead={22} duration={360}><Artifact/></ShotClock></TransitionSeries.Sequence>
    <TransitionSeries.Transition presentation={bridge('rise')} timing={linearTiming({durationInFrames:F(36)})}/>
    <TransitionSeries.Sequence name="05 · Current chat composer" durationInFrames={F(394)}><ShotClock lead={18} duration={360}><Refinement/></ShotClock></TransitionSeries.Sequence>
    <TransitionSeries.Transition presentation={bridge('forward')} timing={linearTiming({durationInFrames:F(32)})}/>
    <TransitionSeries.Sequence name="06 · Refined result" durationInFrames={F(268)}><ShotClock lead={16} duration={240}><Resolution/></ShotClock></TransitionSeries.Sequence>
    <TransitionSeries.Transition presentation={bridge('match')} timing={linearTiming({durationInFrames:F(24)})}/>
    <TransitionSeries.Sequence name="07 · Native feature inserts" durationInFrames={F(754)}><ShotClock lead={12} duration={720}><Features/></ShotClock></TransitionSeries.Sequence>
    <TransitionSeries.Transition presentation={bridge('reveal')} timing={linearTiming({durationInFrames:F(44)})}/>
    <TransitionSeries.Sequence name="08 · Brand close" durationInFrames={F(382)}><ShotClock lead={22} duration={360}><Finale/></ShotClock></TransitionSeries.Sequence>
   </TransitionSeries>
  </div>
 </AbsoluteFill>;
}
