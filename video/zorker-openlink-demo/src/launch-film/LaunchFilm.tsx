import {useEffect,useState} from 'react';
import type {ComponentType,ReactNode} from 'react';
import {AbsoluteFill,Audio,Sequence,continueRender,delayRender,staticFile,useVideoConfig} from 'remotion';
import {Disclosure,Stage,reveal} from '../reference-film/primitives';
import {useShotFrame,ShotClock} from '../reference-film/ShotClock';
import {Intent} from '../reference-film/Intent';
import {Execution} from '../reference-film/Execution';
import {Resolution} from '../reference-film/Resolution';
import {Refinement} from '../reference-film/Refinement';
import {Features} from '../reference-film/Features';
import {Finale} from '../reference-film/Finale';
import {NativeChanges} from '../reference-film/Native';
import {ProductPreview} from '../reference-film/ProductPreview';
import storyboard from './storyboard.json';

type LaunchShot={id:string;title:string;startSeconds:number;durationSeconds:number;sourceFrames?:number;sourceLead?:number};
const shots=storyboard.shots as unknown as LaunchShot[];
const getShot=(id:string)=>{
 const shot=shots.find((candidate)=>candidate.id===id);
 if(!shot)throw new Error('Missing launch-film shot: '+id);
 return shot;
};

function PlainSegment({shotId,children}:{shotId:string;children:ReactNode}){
 const shot=getShot(shotId),{fps}=useVideoConfig();
 return <Sequence from={Math.round(shot.startSeconds*fps)} durationInFrames={Math.round(shot.durationSeconds*fps)} name={shot.title}>{children}</Sequence>;
}

function SourceSegment({shotId,component:Scene}:{shotId:string;component:ComponentType}){
 const shot=getShot(shotId),{fps}=useVideoConfig();
 if(!shot.sourceFrames)throw new Error('Source frame range missing for '+shotId);
 return <Sequence from={Math.round(shot.startSeconds*fps)} durationInFrames={Math.round(shot.durationSeconds*fps)} name={shot.title}>
  <ShotClock lead={shot.sourceLead??0} duration={shot.sourceFrames} playbackFrames={Math.round(shot.durationSeconds*storyboard.designFps)}><Scene/></ShotClock>
 </Sequence>;
}

function OpeningRun(){
 const f=useShotFrame(),phrases=['Builders.','Designers.','Product teams.','Developers.','Zorker OpenLink.'];
 const travel=f*10;
 return <Stage><div style={{position:'absolute',inset:0,overflow:'hidden'}}>
  <div style={{position:'absolute',left:0,top:0,width:6200,height:1080,transform:'translateX('+(-travel)+'px)'}}>
   {phrases.map((phrase,index)=>{
    const left=960+index*1000-960;
    return <div key={phrase} style={{position:'absolute',left,top:0,width:1920,height:1080,display:'flex',alignItems:'center',justifyContent:'center',whiteSpace:'nowrap',fontSize:86,fontWeight:620,letterSpacing:-4.2,color:'#171717'}}>{phrase}</div>;
   })}
  </div>
 </div></Stage>;
}

function Thesis(){
 const f=useShotFrame(),p=reveal(f,0,20);
 return <Stage><div style={{position:'absolute',left:180,right:180,top:375,textAlign:'center',fontSize:86,lineHeight:1.12,fontWeight:620,letterSpacing:-5.2,opacity:p,translate:'0 '+((1-p)*26)+'px'}}>
  <div>Every good build starts</div><div style={{color:'#2563eb'}}>with a clear brief.</div>
 </div></Stage>;
}

function ProofBeat(){
 const f=useShotFrame();
 if(f<180){
  const p=reveal(f,0,20);
  return <Stage><div style={{position:'absolute',left:200,right:200,top:420,textAlign:'center',fontSize:96,fontWeight:640,letterSpacing:-6,opacity:p,translate:'0 '+((1-p)*28)+'px'}}>See what <span style={{color:'#2563eb'}}>changed.</span></div></Stage>;
 }
 return <Stage><div style={{position:'absolute',left:288,top:315,scale:2.4,transformOrigin:'0 0'}}><NativeChanges animationFrame={f-180}/></div><Disclosure/></Stage>;
}

function WorkspaceReveal(){
 const f=useShotFrame(),p=Math.max(0,Math.min(1,f/45));
 const uiX=720*(1-p),titleX=-1500*p;
 return <Stage>
  <div style={{position:'absolute',left:0,top:0,width:1920,height:1080,transform:'translateX('+uiX+'px)'}}>
   <div style={{position:'absolute',left:240,top:90}}><ProductPreview animationFrame={Math.max(0,Math.round(f-45))}/></div>
  </div>
  <div style={{position:'absolute',left:95,top:408,width:910,fontSize:88,lineHeight:1.08,fontWeight:620,letterSpacing:-5.5,transform:'translateX('+titleX+'px)',opacity:1-p}}>Keep the work<br/>in context.</div>
  <Disclosure/>
 </Stage>;
}

function ThemeMontage(){
 const f=useShotFrame(),p=reveal(f,90,180);
 return <Stage>
  <div style={{position:'absolute',left:240,top:90,opacity:1-p}}><ProductPreview animationFrame={180}/></div>
  <div style={{position:'absolute',left:240,top:90,opacity:p}}><ProductPreview blue animationFrame={180}/></div>
  <Disclosure/>
 </Stage>;
}

function LaunchCloser(){
 const f=useShotFrame(),{fps}=useVideoConfig();
 if(f<120){
  const p=reveal(f,0,20);
  return <Stage><div style={{position:'absolute',left:180,right:180,top:430,textAlign:'center',fontSize:96,fontWeight:630,letterSpacing:-6,opacity:p,translate:'0 '+((1-p)*28)+'px'}}>Build in <span style={{color:'#2563eb'}}>context.</span></div></Stage>;
 }
 return <Sequence from={Math.round(2*fps)} durationInFrames={Math.round(5*fps)} name="Zorker OpenLink logo lockup">
  <ShotClock lead={22} duration={360} playbackFrames={300}><Finale/></ShotClock>
 </Sequence>;
}

export function LaunchFilm(){
 const {width}=useVideoConfig();
 const [fontHandle]=useState(()=>delayRender('Load local brand font for OpenLink launch film'));
 useEffect(()=>{document.fonts.load('500 32px OpenLinkGeist').then(()=>continueRender(fontHandle));},[fontHandle]);
 return <AbsoluteFill className="film reference-film launch-film" style={{background:'#ffffff',fontFamily:'OpenLinkGeist, sans-serif'}}>
  <Audio src={staticFile('audio/openlink-launch-sfx-only.wav')}/>
  <div style={{position:'absolute',width:1920,height:1080,zoom:width/1920,overflow:'hidden'}}>
   <PlainSegment shotId="opening"><OpeningRun/></PlainSegment>
   <PlainSegment shotId="thesis"><Thesis/></PlainSegment>
   <SourceSegment shotId="ask" component={Intent}/>
   <SourceSegment shotId="work" component={Execution}/>
   <SourceSegment shotId="result" component={Resolution}/>
   <PlainSegment shotId="evidence"><ProofBeat/></PlainSegment>
   <SourceSegment shotId="refine" component={Refinement}/>
   <PlainSegment shotId="workspace"><WorkspaceReveal/></PlainSegment>
   <PlainSegment shotId="customize"><ThemeMontage/></PlainSegment>
   <SourceSegment shotId="inspect" component={Features}/>
   <PlainSegment shotId="close"><LaunchCloser/></PlainSegment>
  </div>
 </AbsoluteFill>;
}
