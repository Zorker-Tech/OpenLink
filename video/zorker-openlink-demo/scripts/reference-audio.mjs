// Original, deterministic synthesis. No sampled music or downloaded sound effects.
import fs from 'node:fs';
const sr=48000,duration=60,n=sr*duration,left=new Float64Array(n),right=new Float64Array(n);
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
// Warm suspended harmonic bed. Long attacks leave room for the visual transitions.
for(const [at,chord] of [[0,[146.83,220,293.66]],[9,[130.81,196,293.66]],[22,[116.54,174.61,261.63]],[32,[146.83,220,329.63]],[42,[130.81,196,293.66]],[52,[146.83,220,293.66]]]) {
 for(let j=0;j<chord.length;j++)tone(at,Math.min(12,duration-at),chord[j],.034,(j-1)*.55,'pad');
}
const notes=[587.33,440,659.25,880,587.33,523.25,440,293.66];
for(let beat=0;beat<81;beat++) {
 const at=4+beat*.625;
 if(at>54)break;
 if(beat%4===0)tone(at,1,73.416,.11,0,'bass');
 if(beat%2===0)tone(at,1.6,notes[(beat/2)%notes.length],.036,Math.sin(beat)*.45);
}
for(const [at,hz] of [[.3,587.33],[1.1,880],[2.1,1174.66],[5.1,440],[15,587.33],[26,880],[38,659.25],[42,440],[54.1,293.66],[56.2,587.33]])tone(at,2.5,hz,.06,.15);
for(const at of [3.2,7.1,12.6,14.6,25.7,31.8,37.7,41.7,45.7,49.7,53.7])air(at,.8,.2);
for(const at of [13.75,37.2,42.5833,43.25,45.6667,52.2]) {tone(at,.15,1700,.07,0);tone(at,.18,290,.06,0);}
for(const [start,end] of [[7.84,11.08],[32.5,35.2]])for(let at=start;at<end;at+=.115)tone(at,.036,2200+(Math.floor(at*100)%8)*180,.01,Math.sin(at)*.2);
let peak=0,sum=0;
const pcm=Buffer.alloc(n*4);
for(let i=0;i<n;i++) {
 const fade=Math.min(1,i/(sr*.12),(n-1-i)/(sr*1.3));
 const l=Math.tanh(left[i]*1.8)*.78*fade,r=Math.tanh(right[i]*1.8)*.78*fade;
 peak=Math.max(peak,Math.abs(l),Math.abs(r));sum+=l*l+r*r;
 pcm.writeInt16LE(Math.round(l*32767),i*4);pcm.writeInt16LE(Math.round(r*32767),i*4+2);
}
const header=Buffer.alloc(44);header.write('RIFF');header.writeUInt32LE(36+pcm.length,4);header.write('WAVEfmt ',8);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(2,22);header.writeUInt32LE(sr,24);header.writeUInt32LE(sr*4,28);header.writeUInt16LE(4,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(pcm.length,40);
fs.mkdirSync('public/audio',{recursive:true});fs.writeFileSync('public/audio/openlink-reference-original-60s.wav',Buffer.concat([header,pcm]));
const report={duration,sampleRate:sr,channels:2,peakDbFS:20*Math.log10(peak),rmsDbFS:20*Math.log10(Math.sqrt(sum/(n*2))),clippedSamples:0,finalSamples:[pcm.readInt16LE(pcm.length-4),pcm.readInt16LE(pcm.length-2)],rights:'Original procedural synthesis; no external audio sources.',listeningReview:false};
fs.writeFileSync('provenance/reference-audio.json',JSON.stringify(report,null,2));console.log(report);
