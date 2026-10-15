import {bundle} from '@remotion/bundler';
import {enableTailwind} from '@remotion/tailwind-v4';
import {openBrowser,renderMedia,renderStill,selectComposition} from '@remotion/renderer';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const storyboard=JSON.parse(fs.readFileSync('src/launch-film/storyboard.json','utf8'));
const output=path.resolve(process.env.FILM_OUTPUT||'/Users/yikewang/Movies/Zorker-OpenLink-Launch-20261012');
const qa=path.join(output,'qa');
const bundleDir=fs.mkdtempSync(path.join(os.tmpdir(),'openlink-launch-film-'));
const browserExecutable=process.env.CHROME_BIN||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const samples=[
  0.08,1.2,2.8,4.4,6.1,7.9,8.08,8.7,9.9,
  10.08,10.5,12.2,14.4,17.9,18.08,18.4,21.2,24.8,26.9,
  27.08,27.6,29.2,30.9,31.08,31.9,33.2,34.8,36.9,
  37.08,37.5,39.8,42.9,43.08,43.6,45.3,48.9,
  49.08,49.9,51.2,54.9,55.08,55.8,58.1,61.7,63.9,
  64.08,64.6,65.9,66.2,68.5,70.9,
];
const detailSeconds=[12.2,21.2,28.2,33.2,40.2,45.3,52.2,58.1,66.8];
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
  console.log('Bundled launch film:',serveUrl);
  browser=await openBrowser('chrome',{browserExecutable,chromeMode:'chrome-for-testing',chromiumOptions:{headless:true},logLevel:'warn'});
  const composition=await selectComposition({serveUrl,id:'OpenLinkLaunchFilm120',puppeteerInstance:browser});
  assert.deepEqual([composition.width,composition.height,composition.fps,composition.durationInFrames],[3840,2160,120,storyboard.master.durationInFrames]);
  const frames=[...new Set(samples.map(time=>secondsToFrame(time,composition.fps)))].sort((a,b)=>a-b);
  for(const frame of frames){
    const file=path.join(qa,`launch-120-${String(frame).padStart(5,'0')}.png`);
    await renderStill({serveUrl,composition,frame,output:file,imageFormat:'png',scale:0.25,puppeteerInstance:browser,onBrowserLog});
    console.log(`QA still ${frame}/${composition.durationInFrames-1}`);
  }
  for(const seconds of detailSeconds){
    const frame=secondsToFrame(seconds,composition.fps);
    const file=path.join(qa,`launch-detail-${String(frame).padStart(5,'0')}.png`);
    await renderStill({serveUrl,composition,frame,output:file,imageFormat:'png',scale:1,puppeteerInstance:browser,onBrowserLog});
    console.log(`4K detail still ${frame}`);
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
    sampleScale:0.25,
    fullResolutionDetailFrames:detailSeconds.map(seconds=>secondsToFrame(seconds,composition.fps)),
    browserErrors:logErrors,
  };
  fs.writeFileSync(path.join(qa,'launch-film-render-report.json'),JSON.stringify(report,null,2));
  if(process.argv.includes('--video')){
    const outputFile=path.join(output,'Zorker-OpenLink-Launch-4K120.mp4');
    let last=-5;
    await renderMedia({serveUrl,composition,outputLocation:outputFile,codec:'h264',audioCodec:'aac',audioBitrate:'320k',crf:14,imageFormat:'png',pixelFormat:'yuv420p',concurrency:4,puppeteerInstance:browser,onBrowserLog,onProgress:progress=>{
      const next=Math.floor(progress.progress*100/5)*5;
      if(next>last){last=next;console.log(`120fps master render ${next}%`);}
    }});
    assert.equal(logErrors.length,0,JSON.stringify(logErrors));
    console.log('Rendered:',outputFile);
  }
}finally{
  if(browser)await browser.close({silent:true});
  fs.rmSync(bundleDir,{recursive:true,force:true});
}
