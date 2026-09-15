import {bundle} from '@remotion/bundler';
import {enableTailwind} from '@remotion/tailwind-v4';
import {openBrowser,selectComposition,renderStill,renderMedia} from '@remotion/renderer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const output=process.env.FILM_OUTPUT||path.resolve('out/4k');
fs.mkdirSync(path.join(output,'qa'),{recursive:true});
const serveUrl=await bundle({entryPoint:'src/index.ts',outDir:fs.mkdtempSync(path.join(os.tmpdir(),'openlink-4k-')),rspack:true,enableCaching:false,bundlerOverride:c=>enableTailwind({...c,resolve:{...c.resolve,alias:{...c.resolve?.alias,react:path.resolve('node_modules/react'),'react-dom':path.resolve('node_modules/react-dom')}}})});
console.log('4K bundle:',serveUrl);
const browser=await openBrowser('chrome'),errors=[];
const log=l=>{if(l.type==='error')errors.push(l.text);};
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
try{
 const composition=await selectComposition({serveUrl,id:'OpenLinkReferenceFilm',puppeteerInstance:browser});
 assert.equal(composition.width,3840);assert.equal(composition.height,2160);
 const parity=[];
 if(!process.argv.includes('--only-video'))for(const kind of ['Home','Chat']){
  for(const suffix of ['Source','Film']){
   const id=`Current${kind}${suffix}`,c=await selectComposition({serveUrl,id,puppeteerInstance:browser});
   await renderStill({serveUrl,composition:c,frame:0,output:path.join(output,'qa',id+'.png'),imageFormat:'png',puppeteerInstance:browser,onBrowserLog:log});
  }
  const matched=hash(path.join(output,'qa',`Current${kind}Source.png`))===hash(path.join(output,'qa',`Current${kind}Film.png`));
  parity.push({kind,matched});assert.ok(matched,kind+' composer differs from current extracted source presentation');console.log('Composer parity:',kind,matched);
 }
 const cuts=[420,900,1560,1920,2280,2520,2760,3000,3157,3240];
 const frames=process.env.FILM_FRAMES?process.env.FILM_FRAMES.split(',').map(Number):[0,150,350,460,650,780,850,1070,1350,1540,1770,2050,2160,2230,2480,2640,2850,3080,3190,3470,3599,...cuts.flatMap(f=>[f-25,f-13,f-1,f,f+1,f+13,f+25])];
 const scale=Number(process.env.QA_SCALE||.25),repeats=[];
 if(!process.argv.includes('--only-video')){
  for(const frame of [...new Set(frames)]){await renderStill({serveUrl,composition,frame,output:path.join(output,'qa',`frame-${frame}.png`),imageFormat:'png',scale,puppeteerInstance:browser,onBrowserLog:log});console.log('Frame',frame);}
  for(const frame of [3157,2760,2050,1560,900,650,420,150].filter(f=>frames.includes(f))){const p=path.join(output,'qa',`repeat-${frame}.png`);await renderStill({serveUrl,composition,frame,output:p,imageFormat:'png',scale,puppeteerInstance:browser,onBrowserLog:log});const matched=hash(p)===hash(path.join(output,'qa',`frame-${frame}.png`));repeats.push({frame,matched});assert.ok(matched,`Frame ${frame} is history dependent`);}
  fs.writeFileSync(path.join(output,'qa/render-report.json'),JSON.stringify({width:3840,height:2160,fps:60,durationInFrames:3600,frames,scale,parity,repeats,errors,transitionFrames:48,cutCenters:cuts,intermediateImageFormat:'png'},null,2));
  for(const frame of [780,1540,2050,2640]){await renderStill({serveUrl,composition,frame,output:path.join(output,'qa',`detail-${frame}.png`),imageFormat:'png',scale:1,puppeteerInstance:browser,onBrowserLog:log});console.log('4K detail',frame);}
 }
 assert.equal(errors.length,0,JSON.stringify(errors));
 if(process.argv.includes('--video')||process.argv.includes('--only-video')){
  const range=process.env.FRAME_RANGE?.split(',').map(Number);const frameRange=range?[range[0],range[1]]:undefined;
  let last=-1;await renderMedia({serveUrl,composition,outputLocation:path.join(output,frameRange?'OpenLink-4K-transition-test.mp4':'OpenLink-Promo-4K60.mp4'),codec:'h264',audioCodec:'aac',audioBitrate:'320k',crf:14,imageFormat:'png',pixelFormat:'yuv420p',concurrency:4,frameRange,puppeteerInstance:browser,onBrowserLog:log,onProgress:p=>{const n=Math.floor(p.progress*100);if(n>=last+5){last=n;console.log('4K render',n+'%');}}});
  assert.equal(errors.length,0,JSON.stringify(errors));
 }
 console.log('4K output:',output);
}finally{await browser.close({silent:true});}
