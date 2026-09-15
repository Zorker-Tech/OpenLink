import {bundle} from '@remotion/bundler';
import {enableTailwind} from '@remotion/tailwind-v4';
import {openBrowser,selectComposition,renderStill,renderMedia} from '@remotion/renderer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const output=process.env.FILM_OUTPUT||path.resolve('out/fluid-motion');
fs.mkdirSync(path.join(output,'qa'),{recursive:true});
const serveUrl=await bundle({entryPoint:'src/index.ts',outDir:fs.mkdtempSync(path.join(os.tmpdir(),'openlink-4k-')),rspack:true,enableCaching:false,bundlerOverride:c=>enableTailwind({...c,resolve:{...c.resolve,alias:{...c.resolve?.alias,react:path.resolve('node_modules/react'),'react-dom':path.resolve('node_modules/react-dom')}}})});
console.log('4K bundle:',serveUrl);
const browser=await openBrowser('chrome'),errors=[];
const log=l=>{if(l.type==='error')errors.push(l.text);};
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
try{
 const composition=await selectComposition({serveUrl,id:'OpenLinkReferenceFilm',puppeteerInstance:browser});
 assert.equal(composition.width,3840);assert.equal(composition.height,2160);assert.equal(composition.fps,60);assert.equal(composition.durationInFrames,3360);
 const parity=[];
 if(!process.argv.includes('--only-video'))for(const kind of ['Home','Chat']){
  for(const suffix of ['Source','Film']){
   const id=`Current${kind}${suffix}`,c=await selectComposition({serveUrl,id,puppeteerInstance:browser});
   await renderStill({serveUrl,composition:c,frame:0,output:path.join(output,'qa',id+'.png'),imageFormat:'png',puppeteerInstance:browser,onBrowserLog:log});
  }
  const matched=hash(path.join(output,'qa',`Current${kind}Source.png`))===hash(path.join(output,'qa',`Current${kind}Film.png`));
  parity.push({kind,matched});assert.ok(matched,kind+' composer differs from current extracted source presentation');console.log('Composer parity:',kind,matched);
 }
 const cuts=[3,11,22,28,34,38,42,46,48.6166666667,50].map(t=>Math.round(t*60));
 const frames=process.env.FILM_FRAMES?process.env.FILM_FRAMES.split(',').map(Number):[...([0,.5,1,2,3.3,4,4.5,5,6,7,8,9.5,10,11.2,11.8,13.5,15.5,17.5,18,19,20.8,22.5,25,28.6,30,32.5,33.4,34.8,36.2,38.5,39.5,40.5,41.5,42.5,44,46.3,47.3,48.3,49,50.5,53,55.9].map(t=>Math.round(t*60))),360,361,1440,1441,1530,1531,2160,2161,3359,...cuts.flatMap(f=>[f-23,f-12,f-1,f,f+1,f+12,f+23])];
 const scale=Number(process.env.QA_SCALE||.25),repeats=[],fractionalMotion=[];
 if(!process.argv.includes('--only-video')){
  for(const frame of [...new Set(frames)]){await renderStill({serveUrl,composition,frame,output:path.join(output,'qa',`frame-${frame}.png`),imageFormat:'png',scale,puppeteerInstance:browser,onBrowserLog:log});console.log('Frame',frame);}
  for(const frame of [2880,2520,2160,1800,1440,660,360,60].filter(f=>frames.includes(f))){const p=path.join(output,'qa',`repeat-${frame}.png`);await renderStill({serveUrl,composition,frame,output:p,imageFormat:'png',scale,puppeteerInstance:browser,onBrowserLog:log});const matched=hash(p)===hash(path.join(output,'qa',`frame-${frame}.png`));repeats.push({frame,matched});assert.ok(matched,`Frame ${frame} is history dependent`);}
  for(const [a,b] of [[360,361],[1440,1441],[1530,1531],[2160,2161]])if(frames.includes(a)&&frames.includes(b)){const different=hash(path.join(output,'qa',`frame-${a}.png`))!==hash(path.join(output,'qa',`frame-${b}.png`));fractionalMotion.push({a,b,different});assert.ok(different,`Unexpected stationary motion frames at ${a}`);}
  fs.writeFileSync(path.join(output,'qa/render-report.json'),JSON.stringify({width:3840,height:2160,fps:60,durationInFrames:3360,frames,scale,parity,repeats,fractionalMotion,errors,transitionFrames:'varied 24-44 design frames',cutCenters:cuts,intermediateImageFormat:'png'},null,2));
  for(const frame of [360,1230,1800,2370]){await renderStill({serveUrl,composition,frame,output:path.join(output,'qa',`detail-${frame}.png`),imageFormat:'png',scale:1,puppeteerInstance:browser,onBrowserLog:log});console.log('4K detail',frame);}
 }
 assert.equal(errors.length,0,JSON.stringify(errors));
 if(process.argv.includes('--video')||process.argv.includes('--only-video')){
  const range=process.env.FRAME_RANGE?.split(',').map(Number);const frameRange=range?[range[0],range[1]]:undefined;
  let last=-1;await renderMedia({serveUrl,composition,outputLocation:path.join(output,frameRange?'OpenLink-4K-transition-test.mp4':'OpenLink-Fluid-Motion-4K60.mp4'),codec:'h264',audioCodec:'aac',audioBitrate:'320k',crf:14,imageFormat:'png',pixelFormat:'yuv420p',concurrency:4,frameRange,puppeteerInstance:browser,onBrowserLog:log,onProgress:p=>{const n=Math.floor(p.progress*100);if(n>=last+5){last=n;console.log('4K render',n+'%');}}});
  assert.equal(errors.length,0,JSON.stringify(errors));
 }
 console.log('4K output:',output);
}finally{await browser.close({silent:true});}
