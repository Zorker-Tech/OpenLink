import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const storyboard=JSON.parse(fs.readFileSync(path.join(root,'src/launch-film/storyboard-v2.json'),'utf8'));
const sampleRate=storyboard.audio.sampleRate,duration=storyboard.runtimeSeconds;
const sampleFrames=Math.round(sampleRate*duration),left=new Float32Array(sampleFrames),right=new Float32Array(sampleFrames),tau=Math.PI*2;
const clamp=(v)=>Math.min(1,Math.max(0,v));
const cues=[];

function add(at,len,fn,pan=0){
 const start=Math.max(0,Math.round(at*sampleRate)),end=Math.min(sampleFrames,start+Math.round(len*sampleRate));
 const gl=Math.sqrt((1-pan)/2),gr=Math.sqrt((1+pan)/2);
 for(let i=start;i<end;i++){const value=fn((i-start)/sampleRate);left[i]+=value*gl;right[i]+=value*gr;}
}

function pad(at,len,hz,gain,pan=0){
 add(at,len,(t)=>{
  const attack=clamp(t/1.25),release=clamp((len-t)/1.8),env=Math.min(attack,release);
  const fundamental=Math.sin(tau*hz*t),overtone=.16*Math.sin(tau*hz*2.003*t+.4);
  const slowPulse=.86+.14*Math.sin(tau*.11*t+.7);
  return (fundamental+overtone)*gain*env*slowPulse;
 },pan);
}

function kick(at,gain=.24){
 add(at,.22,(t)=>{
  const pitch=42+58*Math.exp(-t*24),env=Math.exp(-t*20),click=Math.exp(-t*105)*.22;
  return Math.sin(tau*pitch*t)*gain*env+click*gain;
 },.02);
}

function pluck(at,hz,gain=.06,pan=0){
 add(at,.34,(t)=>{
  const env=Math.exp(-t*10)*(1-Math.exp(-t*120));
  const body=Math.sin(tau*hz*t)+.19*Math.sin(tau*hz*2.01*t);
  return body*gain*env;
 },pan);
}

function riser(at,len=.72){
 let seed=(0x271a93+Math.round(at*1000))>>>0,low=0;
 add(at,len,(t)=>{
  seed=(1664525*seed+1013904223)>>>0;
  const noise=seed/4294967296*2-1;low=.93*low+.07*noise;
  const p=t/len,env=p*p*(1-p)*4;
  const sweep=Math.sin(tau*(170+780*p)*t);
  return (low*.18+sweep*.12)*env;
 },-.09);
}

function click(at,index){
 const pan=(index%3-1)*.09;
 add(at,.11,(t)=>{
  const transient=Math.exp(-t*125);
  const body=Math.sin(tau*(1480-3100*t)*t)*Math.exp(-t*45);
  return .16*(transient*.42+body*.58);
 },pan);
 add(at+.004,.13,(t)=>Math.sin(tau*315*t)*Math.exp(-t*34)*.13,-pan);
}

function keyboard(at,index,character){
 let seed=(0x91ab73+index*7919)>>>0,low=0;
 const length=.076,pitch=(character===' '?145:205)+(index%7-3)*11,gain=(character===' '?.095:.09)*(0.9+(index%5)*.04);
 add(at,length,(t)=>{
  seed=(1664525*seed+1013904223)>>>0;
  const noise=seed/4294967296*2-1;low=.78*low+.22*noise;
  const high=noise-low,strike=Math.min(1,t/.0007)*Math.exp(-t/.0045);
  const body=Math.sin(tau*pitch*t)*Math.exp(-t/.014)*.42;
  const release=t>.026?high*.24*Math.exp(-(t-.026)/.004):0;
  return gain*(high*strike+body+release)*Math.min(1,(length-t)/.005);
 },((index%9)-4)*.018);
}

const chords=[
 [146.83,220,277.18,329.63],
 [123.47,185,220,293.66],
 [98,146.83,196,246.94],
 [110,164.81,220,277.18],
 [130.81,196,246.94,329.63],
 [146.83,220,277.18,369.99],
 [110,164.81,220,293.66],
 [146.83,220,277.18,329.63],
];
chords.forEach((notes,index)=>{
 const start=index*9.2,len=Math.min(11.2,duration-start);
 notes.forEach((hz,voice)=>pad(start,len,hz,.052-voice*.004,(voice-1.5)*.12));
});

const bpm=96,beatSeconds=60/bpm,totalBeats=Math.ceil(duration/beatSeconds);
const scale=[0,2,4,7,9,11,14];
for(let beat=0;beat<totalBeats;beat++){
 const at=beat*beatSeconds;
 if(at>=duration)break;
 if(beat%4===0)kick(at,at>=63?0.27:0.22);
 const chordIndex=Math.min(chords.length-1,Math.floor(at/9.2));
 const notes=chords[chordIndex],degree=scale[(beat*3+Math.floor(beat/4))%scale.length];
 const hz=notes[degree%notes.length]*2;
 if(beat%2===1)pluck(at,hz,.043,beat%4===1?-.16:.16);
 else pluck(at+.25,notes[(degree+1)%notes.length]*2,.027,beat%4===0?.2:-.2);
}

for(const at of storyboard.audio.sfx.risersAtSeconds)riser(Math.max(0,at-.55),.66);
for(const [index,cue] of storyboard.audio.sfx.clicks.entries()){click(cue.timeSeconds,index);cues.push({type:'click',...cue});}
const native=fs.readFileSync(path.join(root,'src/reference-film/LaunchV2Native.tsx'),'utf8');
const match=/LAUNCH_V2_QUESTION='([^']*)'/.exec(native);
if(!match)throw new Error('Could not find the V2 user prompt for typing audio.');
const chars=Array.from(new Intl.Segmenter('en',{granularity:'grapheme'}).segment(match[1]),(part)=>part.segment);
const typing=storyboard.audio.sfx.typing;
for(let index=0;index<chars.length;index++){
 const at=typing.startSeconds+(index+.5)*(typing.endSeconds-typing.startSeconds)/chars.length;
 keyboard(at,index,chars[index]);
}
cues.push({type:'typing',copy:'LAUNCH_V2_QUESTION',characters:chars.length,startSeconds:typing.startSeconds,endSeconds:typing.endSeconds,intervalSeconds:(typing.endSeconds-typing.startSeconds)/chars.length});

const sting=storyboard.audio.sfx.logoStingSeconds;
[[587.33,0],[739.99,.08],[880,.16],[1174.66,.3]].forEach(([hz,offset],index)=>pluck(sting+offset,hz,.085,index%2?-.16:.16));

const masterEnvelope=[[0,.31],[7.7,.5],[8.1,.78],[10,.88],[14.9,.82],[15.2,.56],[17.8,.58],[18.2,.82],[20,.96],[27.8,.9],[28.2,.78],[36.8,.84],[37.2,1],[48.8,.95],[49.2,.8],[55.8,.82],[56.2,.57],[62.8,.6],[63.2,.79],[66.4,.88],[66.8,1],[70.8,.78],[70.96,.72]];
for(let i=0;i<sampleFrames;i++){
 const t=i/sampleRate;
 let segment=0;
 while(segment<masterEnvelope.length-2&&t>masterEnvelope[segment+1][0])segment++;
 const [aTime,aGain]=masterEnvelope[segment],[bTime,bGain]=masterEnvelope[segment+1];
 const p=clamp((t-aTime)/(bTime-aTime)),smooth=(1-Math.cos(Math.PI*p))/2,gain=aGain+(bGain-aGain)*smooth;
 left[i]*=gain;right[i]*=gain;
}
const compressor={threshold:.14,ratio:3.5,lookaheadMs:2,releaseMs:130};
const lookahead=Math.round(sampleRate*compressor.lookaheadMs/1000),releaseCoeff=Math.exp(-1/(sampleRate*compressor.releaseMs/1000));
const peaks=new Float32Array(sampleFrames),futureMax=new Float32Array(sampleFrames),deque=new Int32Array(sampleFrames);
for(let i=0;i<sampleFrames;i++)peaks[i]=Math.max(Math.abs(left[i]),Math.abs(right[i]));
let head=0,tail=0;
for(let i=sampleFrames-1;i>=0;i--){
 while(head<tail&&deque[head]>i+lookahead)head++;
 while(head<tail&&peaks[deque[tail-1]]<=peaks[i])tail--;
 if(head===tail){head=0;tail=0;}
 deque[tail++]=i;
 futureMax[i]=peaks[deque[head]];
}
let envelope=1;
for(let i=0;i<sampleFrames;i++){
 const level=futureMax[i],wanted=level>compressor.threshold?(compressor.threshold+(level-compressor.threshold)/compressor.ratio)/level:1;
 envelope=wanted<envelope?wanted:releaseCoeff*envelope+(1-releaseCoeff)*wanted;
 left[i]*=envelope;right[i]*=envelope;
}
const finalSilenceFrames=Math.ceil(sampleRate*storyboard.audio.silentEndFramesAtMasterFps/storyboard.master.fps);
for(let i=sampleFrames-finalSilenceFrames;i<sampleFrames;i++){left[i]=0;right[i]=0;}

const tempDir=fs.mkdtempSync(path.join(os.tmpdir(),'openlink-launch-v2-audio-'));
const source=path.join(tempDir,'score-float.wav');
const outputDir=path.join(root,'public/audio');
fs.mkdirSync(outputDir,{recursive:true});
const audioPath=path.join(outputDir,'openlink-launch-v2.wav');
const data=Buffer.alloc(sampleFrames*8);
for(let i=0;i<sampleFrames;i++){data.writeFloatLE(left[i],i*8);data.writeFloatLE(right[i],i*8+4);}
const header=Buffer.alloc(44);
header.write('RIFF',0);header.writeUInt32LE(36+data.length,4);header.write('WAVEfmt ',8);header.writeUInt32LE(16,16);
header.writeUInt16LE(3,20);header.writeUInt16LE(2,22);header.writeUInt32LE(sampleRate,24);header.writeUInt32LE(sampleRate*8,28);
header.writeUInt16LE(8,32);header.writeUInt16LE(32,34);header.write('data',36);header.writeUInt32LE(data.length,40);
fs.writeFileSync(source,Buffer.concat([header,data]));

const ffmpegDir=path.join(root,'node_modules/@remotion/compositor-darwin-arm64');
const ffmpeg=path.join(ffmpegDir,'ffmpeg');
const env={...process.env,DYLD_LIBRARY_PATH:[ffmpegDir,process.env.DYLD_LIBRARY_PATH].filter(Boolean).join(path.delimiter)};
const filter='loudnorm=I=-8:TP=-0.1:LRA=4.5:print_format=json';
function analyze(file){
 const result=spawnSync(ffmpeg,['-hide_banner','-nostats','-i',file,'-af',filter,'-f','null','-'],{env,encoding:'utf8',stdio:['ignore','ignore','pipe']});
 if(result.status!==0)throw new Error('FFmpeg loudnorm analysis failed: '+String(result.stderr).slice(-1200));
 const stderr=String(result.stderr);
 const blocks=stderr.match(/\{[\s\S]*?\}/g);
 if(!blocks?.length)throw new Error('FFmpeg loudnorm analysis did not return JSON: '+stderr.slice(-800));
 return JSON.parse(blocks.at(-1));
}

const sourceMeasure=analyze(source);
const loudnorm='loudnorm=I=-7.2:TP=-0.1:LRA=4.5:print_format=summary';
execFileSync(ffmpeg,['-hide_banner','-y','-i',source,'-af',loudnorm,'-ar',String(sampleRate),'-ac','2','-c:a','pcm_s16le','-t',String(duration),audioPath],{env,stdio:'inherit'});

const normalized=fs.readFileSync(audioPath);
function dataChunk(buffer){
 let offset=12;
 while(offset+8<=buffer.length){
  const id=buffer.toString('ascii',offset,offset+4),size=buffer.readUInt32LE(offset+4);
  if(id==='data')return {offset:offset+8,size};
  offset+=8+size+(size%2);
 }
 throw new Error('Could not locate the normalized WAV data chunk.');
}
const chunk=dataChunk(normalized);
if(chunk.offset+chunk.size!==normalized.length)throw new Error('Normalized audio WAV data length is inconsistent.');
const silenceStart=sampleFrames-finalSilenceFrames;
const postGainDb=-.1,postGain=Math.pow(10,postGainDb/20);
for(let i=0;i<sampleFrames;i++){
 const l=Math.max(-32768,Math.min(32767,Math.round(normalized.readInt16LE(chunk.offset+i*4)*postGain)));
 const r=Math.max(-32768,Math.min(32767,Math.round(normalized.readInt16LE(chunk.offset+i*4+2)*postGain)));
 normalized.writeInt16LE(l,chunk.offset+i*4);normalized.writeInt16LE(r,chunk.offset+i*4+2);
}
for(let i=silenceStart;i<sampleFrames;i++){normalized.writeInt16LE(0,chunk.offset+i*4);normalized.writeInt16LE(0,chunk.offset+i*4+2);}
fs.writeFileSync(audioPath,normalized);
const finalMeasure=analyze(audioPath);
let peak=0,squares=0;
for(let i=0;i<sampleFrames;i++){
 const l=normalized.readInt16LE(chunk.offset+i*4)/32768,r=normalized.readInt16LE(chunk.offset+i*4+2)/32768;
 peak=Math.max(peak,Math.abs(l),Math.abs(r));squares+=l*l+r*r;
}
const report={
  music:true,
  voiceover:false,
  composition:'Original procedural D-add9/Bm7/Gmaj9/Aadd9 electronic keynote bed with soft pulse, plucks, act risers, typed-key and click foley, and logo sting.',
  durationSeconds:duration,
  sampleRate,
  channels:2,
  bitDepth:16,
  target:{integratedLufs:storyboard.audio.integratedLufsTarget,truePeakDbtp:storyboard.audio.truePeakDbtpTarget,loudnessRangeLu:storyboard.audio.loudnessRangeLuTarget},
  compressor,
  filterIntegratedTargetLufs:-7.2,
  postGainDb,
  sourceMeasure,
  measuredIntegratedLufs:Number(finalMeasure.input_i),
  measuredLoudnessRangeLu:Number(finalMeasure.input_lra),
  measuredTruePeakDbtp:Number(finalMeasure.input_tp),
  samplePeakDbfs:20*Math.log10(peak),
  rmsDbfs:20*Math.log10(Math.sqrt(squares/(sampleFrames*2))),
  silentEndFrames:storyboard.audio.silentEndFramesAtMasterFps,
  silentEndSamplesPerChannel:finalSilenceFrames,
  finalSamples:[normalized.readInt16LE(chunk.offset+sampleFrames*4-4),normalized.readInt16LE(chunk.offset+sampleFrames*4-2)],
  cues,
  dynamicsAutomation:masterEnvelope,
  rights:'Original procedural synthesis and foley; no external music or samples.',
};
fs.writeFileSync(path.join(root,'provenance/launch-film-v2-audio.json'),JSON.stringify(report,null,2));
fs.rmSync(tempDir,{recursive:true,force:true});
console.log(JSON.stringify({audioPath,durationSeconds:duration,sampleRate,channels:2,measuredIntegratedLufs:report.measuredIntegratedLufs,measuredLoudnessRangeLu:report.measuredLoudnessRangeLu,measuredTruePeakDbtp:report.measuredTruePeakDbtp,silentEndFrames:report.silentEndFrames},null,2));
