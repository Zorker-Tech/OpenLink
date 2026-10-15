import {bundle} from '@remotion/bundler';
import {enableTailwind} from '@remotion/tailwind-v4';
import {openBrowser,renderMedia,renderStill,selectComposition} from '@remotion/renderer';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const storyboard=JSON.parse(fs.readFileSync('src/launch-film/storyboard-v2.json','utf8'));
const output=path.resolve(process.env.FILM_OUTPUT||'/Users/yikewang/Movies/Zorker-OpenLink-Launch-v2-20261012');
const qa=path.join(output,'qa');
const bundleDir=fs.mkdtempSync(path.join(os.tmpdir(),'openlink-launch-v2-'));
const browserExecutable=process.env.CHROME_BIN||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const samples=[
  0.08,0.45,1.3,2.2,3.2,4.5,5.5,6.7,7.85,
  8.08,8.65,9.92,
  10.08,10.55,11.4,12.7,14.35,14.9,
  15.08,15.5,16.0,16.8,17.6,17.92,
  18.08,18.5,19.25,19.92,
  20.08,20.8,21.55,22.3,23.4,24.8,25.7,27.7,
  28.08,28.6,29.4,30.8,32.0,33.4,34.28,35.2,36.8,
  37.08,38.3,40.5,43.0,46.0,48.9,
  49.08,50.1,51.6,53.3,55.6,
  56.08,57.1,58.4,59.54,60.8,62.9,
  63.08,63.8,65.1,66.4,67.6,69.2,70.9,
];
const detailSeconds=[12.2,16.1,18.7,21.6,25.6,31.9,34.3,41.2,45.6,52.1,54.1,59.8,66.7];
const secondsToFrame=(seconds,fps)=>Math.max(0,Math.min(storyboard.runtimeSeconds*fps-1,Math.round(seconds*fps)));
const logErrors=[];
const onBrowserLog=(entry)=>{if(entry.type==='error')logErrors.push(entry.text);};
let browser;

try{
  fs.mkdirSync(qa,{recursive:true});
  const serveUrl=await bundle({
    entryPoint:'src/index.ts',
    outDir:bundleDir,
    rspack:true,
    enableCaching:false,
    bundlerOverride:config=>enableTailwind({...config,resolve:{...config.resolve,alias:{...config.resolve?.alias,react:path.resolve('node_modules/react'),'react-dom':path.resolve('node_modules/react-dom')}}}),
  });
  console.log('Bundled V2 launch film:',serveUrl);
  browser=await openBrowser('chrome',{browserExecutable,chromeMode:'chrome-for-testing',chromiumOptions:{headless:true},logLevel:'warn'});
  const composition=await selectComposition({serveUrl,id:'OpenLinkLaunchFilmV2-120',puppeteerInstance:browser});
  assert.deepEqual([composition.width,composition.height,composition.fps,composition.durationInFrames],[3840,2160,120,storyboard.master.durationInFrames]);
  const debugFrameArg=process.argv.find(arg=>arg.startsWith('--frame=')||arg.startsWith('--frames='));
  const debugFrames=debugFrameArg?debugFrameArg.slice(debugFrameArg.indexOf('=')+1).split(',').map(Number):[];
  const frames=debugFrameArg?debugFrames:[...new Set(samples.map(time=>secondsToFrame(time,composition.fps)))].sort((a,b)=>a-b);
  for(const frame of frames){
    const file=path.join(qa,'launch-v2-120-'+String(frame).padStart(5,'0')+'.png');
    try{
      await renderStill({serveUrl,composition,frame,output:file,imageFormat:'png',scale:.25,puppeteerInstance:browser,onBrowserLog});
    }catch(error){
      console.error('Browser errors before frame '+frame+':',JSON.stringify(logErrors));
      throw error;
    }
    console.log('V2 QA still '+frame+'/'+(composition.durationInFrames-1));
  }
  for(const seconds of (debugFrameArg?[]:detailSeconds)){
    const frame=secondsToFrame(seconds,composition.fps);
    const file=path.join(qa,'launch-v2-detail-'+String(frame).padStart(5,'0')+'.png');
    await renderStill({serveUrl,composition,frame,output:file,imageFormat:'png',scale:1,puppeteerInstance:browser,onBrowserLog});
    console.log('V2 full-resolution detail still '+frame);
  }
  assert.equal(logErrors.length,0,JSON.stringify(logErrors));
  const report={
    compositionId:composition.id,
    width:composition.width,
    height:composition.height,
    fps:composition.fps,
    durationInFrames:composition.durationInFrames,
    durationSeconds:storyboard.runtimeSeconds,
    sampleFrames:frames,
    sampleScale:.25,
    fullResolutionDetailFrames:detailSeconds.map(seconds=>secondsToFrame(seconds,composition.fps)),
    browserErrors:logErrors,
  };
  fs.writeFileSync(path.join(qa,'launch-film-v2-render-report.json'),JSON.stringify(report,null,2));
  if(process.argv.includes('--video')){
    const outputFile=path.join(output,'Zorker-OpenLink-Launch-4K120.mp4');
    let last=-5;
    await renderMedia({serveUrl,composition,outputLocation:outputFile,codec:'h264',audioCodec:'aac',audioBitrate:'320k',crf:14,imageFormat:'png',pixelFormat:'yuv420p',concurrency:4,puppeteerInstance:browser,onBrowserLog,onProgress:progress=>{
      const next=Math.floor(progress.progress*100/5)*5;
      if(next>last){last=next;console.log('V2 4K120 master render '+next+'%');}
    }});
    assert.equal(logErrors.length,0,JSON.stringify(logErrors));
    console.log('Rendered V2 master:',outputFile);
  }
}finally{
  if(browser)await browser.close({silent:true});
  fs.rmSync(bundleDir,{recursive:true,force:true});
}
