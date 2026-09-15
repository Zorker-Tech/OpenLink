// SFX-only mix: no pads, bass, melody, music pulses, or pitched brand stingers.
import fs from 'node:fs';
const sr=48000,duration=56,n=sr*duration,left=new Float64Array(n),right=new Float64Array(n);
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
const cues=[];
for(const sourceAt of [7.1,12.6,14.6,25.7,31.8,37.7,41.7,45.7,49.7,53.7]) {const at=sourceAt-4;air(at,.8,.2);cues.push({type:'transition',at,duration:.8});}
for(const sourceAt of [13.75,37.2,42.5833,43.25,45.6667,52.2]) {const at=sourceAt-4;tone(at,.15,1700,.07,0);tone(at,.18,290,.06,0);cues.push({type:'click',at,duration:.18});}
for(const [start,end] of [[7.84,11.08],[32.5,35.2]])for(let sourceAt=start;sourceAt<end;sourceAt+=.115){const at=sourceAt-4;tone(at,.036,2200+(Math.floor(sourceAt*100)%8)*180,.01,Math.sin(sourceAt)*.2);cues.push({type:'typing',at,duration:.036});}
let peak=0,sum=0,silentSamples=0;
const pcm=Buffer.alloc(n*4);
for(let i=0;i<n;i++) {
 const fade=Math.min(1,i/(sr*.12),(n-1-i)/(sr*1.3));
 const l=Math.tanh(left[i]*1.8)*.78*fade,r=Math.tanh(right[i]*1.8)*.78*fade;
 peak=Math.max(peak,Math.abs(l),Math.abs(r));sum+=l*l+r*r;if(l===0&&r===0)silentSamples++;
 pcm.writeInt16LE(Math.round(l*32767),i*4);pcm.writeInt16LE(Math.round(r*32767),i*4+2);
}
const header=Buffer.alloc(44);header.write('RIFF');header.writeUInt32LE(36+pcm.length,4);header.write('WAVEfmt ',8);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(2,22);header.writeUInt32LE(sr,24);header.writeUInt32LE(sr*4,28);header.writeUInt16LE(4,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(pcm.length,40);
fs.mkdirSync('public/audio',{recursive:true});fs.writeFileSync('public/audio/openlink-sfx-only.wav',Buffer.concat([header,pcm]));
const report={music:false,cues,silenceRatio:silentSamples/n,duration,sampleRate:sr,channels:2,peakDbFS:20*Math.log10(peak),rmsDbFS:20*Math.log10(Math.sqrt(sum/(n*2))),clippedSamples:0,finalSamples:[pcm.readInt16LE(pcm.length-4),pcm.readInt16LE(pcm.length-2)],rights:'Original procedural synthesis; no external audio sources.',listeningReview:false};
fs.writeFileSync('provenance/sfx-only-audio.json',JSON.stringify(report,null,2));console.log({music:report.music,duration,sampleRate:sr,cues:cues.length,peakDbFS:report.peakDbFS,silenceRatio:report.silenceRatio});
