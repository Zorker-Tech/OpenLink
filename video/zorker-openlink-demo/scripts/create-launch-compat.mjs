import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const output=path.resolve(process.env.FILM_OUTPUT||'/Users/yikewang/Movies/Zorker-OpenLink-Launch-20261012');
const master=path.join(output,'Zorker-OpenLink-Launch-4K120.mp4');
const candidate=path.join(output,'Zorker-OpenLink-Launch-4K60-candidate.mp4');
const delivery=path.join(output,'Zorker-OpenLink-Launch-4K60.mp4');
const ffmpegDir=path.resolve('node_modules/@remotion/compositor-darwin-arm64');
const ffmpeg=path.join(ffmpegDir,'ffmpeg');
const ffprobe=path.join(ffmpegDir,'ffprobe');
const env={...process.env,DYLD_LIBRARY_PATH:[ffmpegDir,process.env.DYLD_LIBRARY_PATH].filter(Boolean).join(path.delimiter)};
const verifyOnly=process.argv.includes('--verify-only');

assert.ok(fs.existsSync(master),'Render the 120 fps master first: '+master);
if(!verifyOnly){
  fs.rmSync(candidate,{force:true});
  execFileSync(ffmpeg,[
    '-hide_banner','-y','-i',master,
    '-r','60','-frames:v','4260',
    '-c:v','libx264','-crf','14','-preset','fast','-pix_fmt','yuv420p',
    '-c:a','copy','-movflags','+faststart',candidate,
  ],{env,stdio:'inherit'});
}

const fileToProbe=verifyOnly?delivery:candidate;
const probe=execFileSync(ffprobe,[
  '-v','error','-count_frames',
  '-show_entries','format=duration,size:stream=index,codec_name,codec_type,width,height,r_frame_rate,avg_frame_rate,duration,nb_frames,nb_read_frames,pix_fmt,sample_rate,channels',
  '-of','json',fileToProbe,
],{env,encoding:'utf8',stdio:['ignore','pipe','inherit']});
const metadata=JSON.parse(probe);
const video=metadata.streams.find(stream=>stream.codec_type==='video');
const audio=metadata.streams.find(stream=>stream.codec_type==='audio');
assert.ok(video,'The compatibility file has a video stream');
assert.ok(audio,'The compatibility file has an audio stream');
assert.deepEqual([video.codec_name,video.width,video.height,video.r_frame_rate,video.avg_frame_rate,video.duration,video.nb_frames,video.nb_read_frames],['h264',3840,2160,'60/1','60/1','71.000000','4260','4260']);
assert.deepEqual([audio.codec_name,audio.sample_rate,audio.channels],['aac','48000',2]);

const presentationTimes=(file)=>execFileSync(ffprobe,['-v','error','-select_streams','v:0','-show_entries','packet=pts_time','-of','csv=p=0',file],{env,encoding:'utf8',maxBuffer:16*1024*1024}).trim().split(/\s+/).map(Number).sort((a,b)=>a-b);
const masterTimes=presentationTimes(master);
const compatibilityTimes=presentationTimes(fileToProbe);
assert.equal(masterTimes.length,8520,'Master presentation timestamp count');
assert.equal(compatibilityTimes.length,4260,'Compatibility presentation timestamp count');
for(let index=0;index<masterTimes.length;index++)assert.ok(Math.abs(masterTimes[index]-index/120)<1e-6,'Master timestamp '+index+' is not on the 120 fps cadence');
for(let index=0;index<compatibilityTimes.length;index++)assert.ok(Math.abs(compatibilityTimes[index]-masterTimes[index*2])<1e-6,'Compatibility timestamp '+index+' does not match master frame '+index*2);

if(!verifyOnly){
  fs.rmSync(delivery,{force:true});
  fs.renameSync(candidate,delivery);
}
console.log(JSON.stringify({delivery,verifiedWithoutRerender:verifyOnly,keepsEveryOtherMasterPresentationFrame:true,metadata},null,2));
