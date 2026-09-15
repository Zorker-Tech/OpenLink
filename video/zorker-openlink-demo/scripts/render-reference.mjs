import {bundle} from '@remotion/bundler';
import {enableTailwind} from '@remotion/tailwind-v4';
import {openBrowser,selectComposition,renderStill,renderMedia} from '@remotion/renderer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const output=process.env.FILM_OUTPUT||path.resolve('out/reference-film');
fs.mkdirSync(path.join(output,'qa'),{recursive:true});
const bundleDir=fs.mkdtempSync(path.join(os.tmpdir(),'openlink-ref-'));
const serveUrl=await bundle({entryPoint:'src/index.ts',outDir:bundleDir,rspack:true,enableCaching:false,bundlerOverride:c=>enableTailwind({...c,resolve:{...c.resolve,alias:{...c.resolve?.alias,react:path.resolve('node_modules/react'),'react-dom':path.resolve('node_modules/react-dom')}}})});
console.log('Bundle:',serveUrl);
const browser=await openBrowser('chrome');
const errors=[];
const onBrowserLog=l=>{if(l.type==='error')errors.push(l.text);};
try {
 const composition=await selectComposition({serveUrl,id:'OpenLinkReferenceFilm',puppeteerInstance:browser});
 const seams=[420,900,1560,1920,2280,2520,2760,3000,3240];
 const frames=process.env.FILM_FRAMES?process.env.FILM_FRAMES.split(',').map(Number):[0,80,150,230,350,460,580,690,810,850,950,1070,1190,1275,1350,1455,1540,1620,1770,1900,2070,2200,2350,2480,2640,2850,3080,3190,3330,3470,3599,...seams.flatMap(f=>[f-1,f,f+1])];
 const scale=Number(process.env.QA_SCALE||.5);
 if(!process.argv.includes('--only-video'))for(const frame of [...new Set(frames)]) {
  await renderStill({serveUrl,composition,frame,output:path.join(output,'qa',`frame-${frame}.png`),scale,imageFormat:'png',puppeteerInstance:browser,onBrowserLog});
  console.log('Frame',frame);
 }
 const repeats=[];
 if(!process.argv.includes('--only-video'))for(const frame of [3190,2640,2200,1540,950,150].filter(f=>frames.includes(f))) {
  const file=path.join(output,'qa',`repeat-${frame}.png`);
  await renderStill({serveUrl,composition,frame,output:file,scale,imageFormat:'png',puppeteerInstance:browser,onBrowserLog});
  const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  const matched=hash(file)===hash(path.join(output,'qa',`frame-${frame}.png`));
  repeats.push({frame,matched});assert.ok(matched,`Non-deterministic frame ${frame}`);
 }
 if(!process.argv.includes('--only-video'))fs.writeFileSync(path.join(output,'qa/render-report.json'),JSON.stringify({composition:composition.id,frames,scale,repeats,browserErrors:errors,width:composition.width,height:composition.height,fps:composition.fps,durationInFrames:composition.durationInFrames},null,2));
 assert.equal(errors.length,0,JSON.stringify(errors));
 if(process.argv.includes('--video')||process.argv.includes('--only-video')) {
  let last=-1;
  await renderMedia({serveUrl,composition,outputLocation:path.join(output,'OpenLink-Reference-Film-1080p60.mp4'),codec:'h264',audioCodec:'aac',audioBitrate:'320k',crf:17,pixelFormat:'yuv420p',concurrency:4,puppeteerInstance:browser,onBrowserLog,onProgress:p=>{const pct=Math.floor(p.progress*100);if(pct>=last+5){console.log('Render',pct+'%');last=pct;}}});
  assert.equal(errors.length,0,JSON.stringify(errors));
 }
 console.log('Complete:',output);
}finally{await browser.close({silent:true});}
