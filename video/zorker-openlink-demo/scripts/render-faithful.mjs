import {bundle} from '@remotion/bundler';
import {enableTailwind} from '@remotion/tailwind-v4';
import {openBrowser,selectComposition,renderStill,renderMedia} from '@remotion/renderer';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const output=process.env.FILM_OUTPUT||'/Users/yikewang/Movies/Zorker-OpenLink-20260908';
fs.mkdirSync(path.join(output,'qa'),{recursive:true});
const bundleDir=fs.mkdtempSync(path.join(os.tmpdir(),'openlink-film-'));
const serveUrl=await bundle({entryPoint:'src/index.ts',outDir:bundleDir,rspack:true,enableCaching:false,bundlerOverride:c=>enableTailwind({...c,resolve:{...c.resolve,alias:{...c.resolve?.alias,react:path.resolve('node_modules/react'),'react-dom':path.resolve('node_modules/react-dom')}}})});
console.log('Bundle ready',serveUrl);
const browser=await openBrowser('chrome');
try {
 const composition=await selectComposition({serveUrl,id:'ZorkerOpenLink',puppeteerInstance:browser});
 const errors=[];
 const seams=[90,1710,...[42,86,142,202,270,338,390,410,430,500,570,690,770,895,965,1280,1325,1435,1490,1585].map(f=>90+f)];
 const frames=process.env.FILM_FRAMES?process.env.FILM_FRAMES.split(',').map(Number):[0,20,40,65,100,132,176,232,292,360,428,480,590,780,930,1055,1370,1515,1675,1750,1799,...seams.flatMap(f=>[f-1,f,f+1])];
 for(const frame of frames) {
  await renderStill({serveUrl,composition,frame,output:path.join(output,'qa',`${frame}.png`),imageFormat:'png',scale:1,puppeteerInstance:browser,onBrowserLog:l=>{if(l.type==='error')errors.push(l.text);}});
  console.log('Frame',frame);
 }
 const repeated=[];
 for(const frame of [...frames].reverse().filter(f=>[232,590,1055,1515].includes(f))) {
  const filename=path.join(output,'qa',`repeat-${frame}.png`);
  await renderStill({serveUrl,composition,frame,output:filename,imageFormat:'png',scale:1,puppeteerInstance:browser});
  const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  assert.equal(hash(filename),hash(path.join(output,'qa',`${frame}.png`)),`Non-deterministic frame ${frame}`);
  repeated.push({frame,matched:true,sha256:hash(filename)});
 }
 for(const id of ['SourceReference','FilmParity']) {
  const reference=await selectComposition({serveUrl,id,puppeteerInstance:browser});
  await renderStill({serveUrl,composition:reference,frame:0,output:path.join(output,'qa',id+'.png'),imageFormat:'png',puppeteerInstance:browser});
 }
 const parityHash=name=>crypto.createHash('sha256').update(fs.readFileSync(path.join(output,'qa',name+'.png'))).digest('hex');
 assert.equal(parityHash('SourceReference'),parityHash('FilmParity'),'Settled source UI differs at same viewport');
 fs.writeFileSync(path.join(output,'qa/report.json'),JSON.stringify({composition:composition.id,frames,repeated,sourceParity:{state:'settled',width:430,height:604,matched:true,sha256:parityHash('FilmParity'),scope:'Timeline original vs frame adapter. Composer shared in both; verified separately by source extraction/class checks.'},browserErrors:errors,width:composition.width,height:composition.height,fps:composition.fps,durationInFrames:composition.durationInFrames},null,2));
 assert.equal(errors.length,0,JSON.stringify(errors));
 if(process.argv.includes('--video')) {
  let last=-1;
  await renderMedia({serveUrl,composition,outputLocation:path.join(output,'Zorker-OpenLink-EN-v3.mp4'),codec:'h264',muted:true,crf:18,concurrency:2,puppeteerInstance:browser,onProgress:p=>{const n=Math.floor(p.progress*10);if(n!==last){console.log('Render',n*10+'%');last=n;}}});
 }
 console.log('Output:',output);
} finally {await browser.close({silent:true});}
