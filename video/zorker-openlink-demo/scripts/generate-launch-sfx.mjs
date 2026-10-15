import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const storyboard=JSON.parse(fs.readFileSync(path.join(root,'src/launch-film/storyboard.json'),'utf8'));
const native=fs.readFileSync(path.join(root,'src/reference-film/Native.tsx'),'utf8');
const sr=storyboard.audio.sampleRate,duration=storyboard.runtimeSeconds,n=Math.round(sr*duration),left=new Float64Array(n),right=new Float64Array(n),tau=Math.PI*2;
const shotById=Object.fromEntries(storyboard.shots.map((shot)=>[shot.id,shot]));
const cues=[];

function tone(at,len,hz,gain,pan=0){
 const start=Math.round(at*sr),length=Math.round(len*sr);
 for(let i=0;i<length&&start+i<n;i++){
  const t=i/sr,attack=Math.min(1,t/.014),release=Math.min(1,(len-t)/.2),env=Math.exp(-t/(len*.22))*attack*release;
  const wave=Math.sin(tau*hz*t)+.24*Math.sin(tau*hz*2.003*t)*Math.exp(-t*2)+.07*Math.sin(tau*hz*3.99*t)*Math.exp(-t*4);
  const sample=wave*gain*env;
  left[start+i]+=sample*Math.sqrt((1-pan)/2);right[start+i]+=sample*Math.sqrt((1+pan)/2);
 }
}

function air(at,len,gain,pan=0){
 let seed=8137,low=0;const start=Math.floor(at*sr),length=Math.round(len*sr);
 for(let i=0;i<length&&start+i<n;i++){
  seed=(1664525*seed+1013904223)>>>0;low=.96*low+.04*(seed/4294967296*2-1);
  const env=Math.sin(Math.PI*i/length)**3,sample=low*gain*env;
  left[start+i]+=sample*(1-pan);right[start+i]+=sample*(1+pan);
 }
}

function keyboard(at,index,character){
 const length=.076,start=Math.round(at*sr),space=character===' ';
 let seed=(0x91ab73+index*7919)>>>0,low=0;
 const pitch=(space?145:205)+(index%7-3)*11,gain=(space?.13:.12)*(0.9+(index%5)*.04);
 for(let i=0;i<Math.round(length*sr)&&start+i<n;i++){
  const t=i/sr;seed=(1664525*seed+1013904223)>>>0;
  const noise=seed/4294967296*2-1;low=.78*low+.22*noise;
  const high=noise-low,strike=Math.min(1,t/.0007)*Math.exp(-t/.0045);
  const body=Math.sin(tau*pitch*t)*Math.exp(-t/.014)*.42;
  const release=t>.026?high*.26*Math.exp(-(t-.026)/.004):0;
  const value=gain*(high*strike+body+release)*Math.min(1,(length-t)/.005),pan=((index%9)-4)*.018;
  left[start+i]+=value*Math.sqrt((1-pan)/2);right[start+i]+=value*Math.sqrt((1+pan)/2);
 }
}

function eventTime(shotId,sourceFrame){
 const shot=shotById[shotId];
 if(!shot||!shot.sourceFrames)throw new Error('Invalid source shot for audio cue: '+shotId);
 return shot.startSeconds+((sourceFrame+(shot.sourceLead??0))/shot.sourceFrames)*shot.durationSeconds;
}

for(const cue of storyboard.audio.swishes){air(cue.timeSeconds,cue.durationSeconds,.15,cue.pan??0);cues.push({type:'transition',...cue});}
for(const cue of storyboard.audio.clicks){
 const at=eventTime(cue.shotId,cue.sourceFrame);tone(at,.11,1700,.065,0);tone(at,.14,290,.055,0);
 cues.push({type:'click',...cue,at,durationSeconds:.14});
}

const readString=(name)=>{
 const match=new RegExp('export const '+name+"='([^']*)'").exec(native);
 if(!match)throw new Error('Could not find '+name+' in Native.tsx');
 return match[1];
};
let keyIndex=0;
for(const typing of storyboard.audio.typing){
 const chars=Array.from(new Intl.Segmenter('en',{granularity:'grapheme'}).segment(readString(typing.copy)),(part)=>part.segment);
 for(let index=0;index<chars.length;index++){
  const sourceFrame=typing.startSourceFrame+(index+1)*typing.durationSourceFrames/chars.length,at=eventTime(typing.shotId,sourceFrame);
  keyboard(at,keyIndex++,chars[index]);
  cues.push({type:'typing',shotId:typing.shotId,sourceFrame,at,durationSeconds:.076,key:chars[index]===' '?'space':'key'});
 }
}

let peak=0,sum=0,silentSamples=0;
const pcm=Buffer.alloc(n*4);
const finalSilenceSamples=Math.ceil(sr*storyboard.audio.silentEndFramesAtMasterFps/storyboard.master.fps);
for(let i=0;i<n;i++){
 const fade=Math.min(1,i/(sr*.12),(n-1-i)/(sr*1.3));
 const silent=i>=n-finalSilenceSamples;
 const l=silent?0:Math.tanh(left[i]*1.8)*.78*fade,r=silent?0:Math.tanh(right[i]*1.8)*.78*fade;
 peak=Math.max(peak,Math.abs(l),Math.abs(r));sum+=l*l+r*r;if(l===0&&r===0)silentSamples++;
 pcm.writeInt16LE(Math.round(l*32767),i*4);pcm.writeInt16LE(Math.round(r*32767),i*4+2);
}

const header=Buffer.alloc(44);header.write('RIFF');header.writeUInt32LE(36+pcm.length,4);header.write('WAVEfmt ',8);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(2,22);header.writeUInt32LE(sr,24);header.writeUInt32LE(sr*4,28);header.writeUInt16LE(4,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(pcm.length,40);
const audioPath=path.join(root,'public/audio/openlink-launch-sfx-only.wav');
fs.writeFileSync(audioPath,Buffer.concat([header,pcm]));
const report={music:false,voiceover:false,durationSeconds:duration,sampleRate:sr,channels:2,keyboardCues:keyIndex,cues,finalSilenceFrames:storyboard.audio.silentEndFramesAtMasterFps,finalSilenceSamples,peakDbFS:20*Math.log10(peak),rmsDbFS:20*Math.log10(Math.sqrt(sum/(n*2))),silenceRatio:silentSamples/n,clippedSamples:0,finalSamples:[pcm.readInt16LE(pcm.length-4),pcm.readInt16LE(pcm.length-2)],rights:'Original procedural synthesis; no external audio sources.',listeningReview:false};
fs.writeFileSync(path.join(root,'provenance/launch-film-audio.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({audioPath,durationSeconds:duration,sampleRate:sr,channels:2,keyboardCues:keyIndex,totalCues:cues.length,peakDbFS:report.peakDbFS},null,2));
