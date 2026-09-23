// SFX-only mix: no pads, bass, melody, music pulses, or pitched brand stingers.
import fs from 'node:fs';
import storyboard from '../src/reference-film/storyboard-v10.json' with {type:'json'};
const sr=48000,duration=storyboard.runtimeFrames/storyboard.format.fps,n=Math.round(sr*duration),left=new Float64Array(n),right=new Float64Array(n);
const tau=Math.PI*2;
function tone(at,len,hz,gain,pan=0,kind='bell') {
 const start=Math.round(at*sr),length=Math.round(len*sr);
 for(let i=0;i<length&&start+i<n;i++) {
  const t=i/sr,attack=Math.min(1,t/.014),release=Math.min(1,(len-t)/.2);
  const env=kind==='pad'?Math.sin(Math.PI*t/len)**2:Math.exp(-t/(len*.22))*attack*release;
  const wave=kind==='bass'?Math.sin(tau*(hz*t+1.8*(1-Math.exp(-t*18)))):
   Math.sin(tau*hz*t)+.24*Math.sin(tau*hz*2.003*t)*Math.exp(-t*2)+.07*Math.sin(tau*hz*3.99*t)*Math.exp(-t*4);
  const sample=wave*gain*env;
  left[start+i]+=sample*Math.sqrt((1-pan)/2);right[start+i]+=sample*Math.sqrt((1+pan)/2);
 }
}
function air(at,len,gain,pan=0) {
 let seed=8137,lp=0;
 const start=Math.floor(at*sr);
 for(let i=0;i<len*sr&&start+i<n;i++) {
  seed=(1664525*seed+1013904223)>>>0;
  lp=.96*lp+.04*(seed/4294967296*2-1);
  const env=Math.sin(Math.PI*i/(len*sr))**3;
  left[start+i]+=lp*gain*env*(1-pan);right[start+i]+=lp*gain*env*(1+pan);
 }
}

function keyboard(at,index,character) {
 const length=.076,start=Math.round(at*sr),space=character===' ';
 let seed=(0x91ab73+index*7919)>>>0,low=0;
 const pitch=(space?145:205)+(index%7-3)*11;
 const gain=(space?.13:.12)*(0.9+(index%5)*.04);
 for(let i=0;i<Math.round(length*sr)&&start+i<n;i++){
  const t=i/sr;seed=(1664525*seed+1013904223)>>>0;
  const noise=seed/4294967296*2-1;low=.78*low+.22*noise;const high=noise-low;
  const strike=Math.min(1,t/.0007)*Math.exp(-t/.0045);
  const body=Math.sin(tau*pitch*t)*Math.exp(-t/.014)*.42;
  const release=t>.026?high*.26*Math.exp(-(t-.026)/.004):0;
  const value=gain*(high*strike+body+release)*Math.min(1,(length-t)/.005);
  const pan=((index%9)-4)*.018;
  left[start+i]+=value*Math.sqrt((1-pan)/2);right[start+i]+=value*Math.sqrt((1+pan)/2);
 }
}

const native=fs.readFileSync('src/reference-film/Native.tsx','utf8');
const prompt=/export const PROMPT='([^']*)'/.exec(native)[1];
const revision=/export const REVISION='([^']*)'/.exec(native)[1];
const intent=fs.readFileSync('src/reference-film/Intent.tsx','utf8'),refinement=fs.readFileSync('src/reference-film/Refinement.tsx','utf8');
if(!intent.includes('(f-50)/300*PROMPT.length')||!refinement.includes('(f-30)/162*REVISION.length'))throw Error('Visual typing timing changed; update the keyboard cue scheduler.');
const cues=[];
const shotById=Object.fromEntries(storyboard.shots.map(shot=>[shot.id,shot]));
function frameForSource(shotId,sourceFrame){
 const shot=shotById[shotId];
 return shot.sequenceStart+Math.ceil((sourceFrame+shot.sourceLead)*shot.activeFrames/shot.sourceFrames-1e-9);
}
for(const transition of storyboard.transitions){
 const cueFrames=Math.min(14,transition.frames-2),frame=transition.startFrame+(transition.frames-cueFrames)/2,at=frame/storyboard.format.fps,d=cueFrames/storyboard.format.fps;
 air(at,d,.16,transition.kind==='rise'?.16:-.12);cues.push({type:'transition',from:transition.from,to:transition.to,frame,at,duration:d});
}
const visibleClicks=[['prompt',405],['refine',312],['proof',35],['proof',75],['proof',220],['proof',612]];
for(const [shotId,sourceFrame] of visibleClicks){const frame=frameForSource(shotId,sourceFrame),at=frame/storyboard.format.fps;tone(at,.11,1700,.065,0);tone(at,.14,290,.055,0);cues.push({type:'click',shot:shotId,sourceFrame,frame,at,duration:.14});}
let keyIndex=0;
function typeText(shotId,start,length,text){
 for(let index=0;index<text.length;index++){
  const sourceFrame=start+(index+1)*length/text.length,frame=frameForSource(shotId,sourceFrame),at=frame/storyboard.format.fps;
  keyboard(at,keyIndex++,text[index]);cues.push({type:'typing',shot:shotId,sourceFrame,frame,at,duration:.076,key:text[index]===' '?'space':'key'});
 }
}
typeText('prompt',50,300,prompt);typeText('refine',30,162,revision);
if(keyIndex!==prompt.length+revision.length)throw Error('Keyboard cue count does not match visible characters');
let peak=0,sum=0,silentSamples=0;
const pcm=Buffer.alloc(n*4);
for(let i=0;i<n;i++) {
 const fade=Math.min(1,i/(sr*.12),(n-1-i)/(sr*1.3));
 const l=Math.tanh(left[i]*1.8)*.78*fade,r=Math.tanh(right[i]*1.8)*.78*fade;
 peak=Math.max(peak,Math.abs(l),Math.abs(r));sum+=l*l+r*r;if(l===0&&r===0)silentSamples++;
 pcm.writeInt16LE(Math.round(l*32767),i*4);pcm.writeInt16LE(Math.round(r*32767),i*4+2);
}
const header=Buffer.alloc(44);header.write('RIFF');header.writeUInt32LE(36+pcm.length,4);header.write('WAVEfmt ',8);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(2,22);header.writeUInt32LE(sr,24);header.writeUInt32LE(sr*4,28);header.writeUInt16LE(4,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(pcm.length,40);
fs.mkdirSync('public/audio',{recursive:true});fs.writeFileSync('public/audio/openlink-keyboard-sfx.wav',Buffer.concat([header,pcm]));
const report={music:false,keyboardCues:keyIndex,keyboardSync:"one keydown on the first output frame each character becomes visible",timingSource:'src/reference-film/storyboard-v10.json',cues,silenceRatio:silentSamples/n,duration,sampleRate:sr,channels:2,peakDbFS:20*Math.log10(peak),rmsDbFS:20*Math.log10(Math.sqrt(sum/(n*2))),clippedSamples:0,finalSamples:[pcm.readInt16LE(pcm.length-4),pcm.readInt16LE(pcm.length-2)],rights:'Original procedural synthesis; no external audio sources.',listeningReview:false};
fs.writeFileSync('provenance/keyboard-sfx-audio.json',JSON.stringify(report,null,2));console.log({music:report.music,duration,sampleRate:sr,cues:cues.length,keyboardCues:keyIndex,peakDbFS:report.peakDbFS,silenceRatio:report.silenceRatio});
