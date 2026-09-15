import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const binary=path.resolve('node_modules/@remotion/compositor-darwin-arm64');
const files=process.argv.slice(2),reports=[];
for(const file of files){
 const data=JSON.parse(execFileSync(path.join(binary,'ffprobe'),['-v','error','-select_streams','v:0','-show_entries','stream=r_frame_rate:frame=best_effort_timestamp_time','-of','json',file],{env:{...process.env,DYLD_LIBRARY_PATH:binary},encoding:'utf8',maxBuffer:8e6}));
 const [n,d]=data.streams[0].r_frame_rate.split('/').map(Number),fps=n/d,t=data.frames.map(f=>Number(f.best_effort_timestamp_time));
 const gaps=[],duplicates=[];for(let i=1;i<t.length;i++){const delta=t[i]-t[i-1];if(delta>1.5/fps)gaps.push({frame:i,delta});if(delta<=0)duplicates.push(i);}
 reports.push({file,fps,frames:t.length,timestampGaps:gaps,nonIncreasingTimestamps:duplicates});
}
fs.writeFileSync(process.env.PACING_REPORT||'provenance/pacing-audit-before.json',JSON.stringify(reports,null,2));console.log(JSON.stringify(reports,null,2));
