import {bundle} from '@remotion/bundler';
import {enableTailwind} from '@remotion/tailwind-v4';
import {openBrowser,selectComposition,renderStill,renderMedia} from '@remotion/renderer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const board=JSON.parse(fs.readFileSync('src/reference-film/storyboard-v10.json','utf8'));
const {width,height,fps}=board.format,framesTotal=board.runtimeFrames;
const output=process.env.FILM_OUTPUT||path.resolve('out/fluid-motion');
const qa=path.resolve(process.env.FILM_QA_OUTPUT||path.join(output,'qa'));fs.mkdirSync(qa,{recursive:true});fs.mkdirSync(output,{recursive:true});
const bundleDir=fs.mkdtempSync(path.join(os.tmpdir(),'openlink-paced-'));
const serveUrl=await bundle({entryPoint:'src/index.ts',outDir:bundleDir,rspack:true,enableCaching:false,bundlerOverride:c=>enableTailwind({...c,resolve:{...c.resolve,alias:{...c.resolve?.alias,react:path.resolve('node_modules/react'),'react-dom':path.resolve('node_modules/react-dom')}}})});
console.log('4K bundle:',serveUrl);
const browserExecutable=process.env.CHROME_BIN||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
let browser;const errors=[];
const log=l=>{if(l.type==='error')errors.push(l.text);};
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const frameAtSource=(shotId,sourceFrame)=>{
 const shot=board.shots.find(s=>s.id===shotId);assert.ok(shot,shotId);
 return shot.sequenceStart+Math.ceil((sourceFrame+shot.sourceLead)*shot.activeFrames/shot.sourceFrames-1e-9);
};
const inBounds=f=>Math.max(0,Math.min(framesTotal-1,Math.round(f)));
try{
 browser=await openBrowser('chrome',{browserExecutable,chromeMode:'chrome-for-testing',chromiumOptions:{headless:true},logLevel:'warn'});
 const composition=await selectComposition({serveUrl,id:'OpenLinkReferenceFilm',puppeteerInstance:browser});
 assert.deepEqual([composition.width,composition.height,composition.fps,composition.durationInFrames],[width,height,fps,framesTotal]);
 const parity=[];
 if(!process.argv.includes('--only-video'))for(const kind of ['Home','Chat']){
  for(const suffix of ['Source','Film']){
   const id=`Current${kind}${suffix}`,c=await selectComposition({serveUrl,id,puppeteerInstance:browser});
   await renderStill({serveUrl,composition:c,frame:0,output:path.join(qa,id+'.png'),imageFormat:'png',puppeteerInstance:browser,onBrowserLog:log});
  }
  const matched=hash(path.join(qa,`Current${kind}Source.png`))===hash(path.join(qa,`Current${kind}Film.png`));
  parity.push({kind,matched});assert.ok(matched,kind+' composer differs from current extracted source presentation');console.log('Composer parity:',kind,matched);
 }
 const transitionFrames=board.transitions.flatMap(t=>[t.startFrame-1,t.startFrame,t.startFrame+Math.floor(t.frames/2),t.startFrame+t.frames-1,t.startFrame+t.frames].map(inBounds));
 const shotSamples=board.shots.flatMap(s=>[.08,.25,.5,.75,.92].map(p=>inBounds(s.activeStart+s.activeFrames*p)));
 const repeatedFrames=[...new Set(board.shots.map(s=>inBounds(s.activeStart+Math.floor(s.activeFrames/2))))];
 const motionChecks=[['logo',50],['logo',51],['prompt',35],['prompt',36],['work',140],['work',141],['workspace',55],['workspace',56],['refine',30],['refine',31],['result',114],['result',115],['proof',35],['proof',36],['close',40],['close',41]];
 const motionPairs=motionChecks.reduce((all,entry,index)=>index%2?[...all, [frameAtSource(motionChecks[index-1][0],motionChecks[index-1][1]),frameAtSource(entry[0],entry[1])]]:all,[]);
 const frameList=process.env.FILM_FRAMES?[...process.env.FILM_FRAMES.split(',').map(Number),...motionPairs.flat(),...repeatedFrames]:[0,framesTotal-1,...shotSamples,...transitionFrames,...motionPairs.flat()];
 const frames=[...new Set(frameList.map(inBounds))].sort((a,b)=>a-b),scale=Number(process.env.QA_SCALE||.25),repeats=[],fractionalMotion=[];
 assert.ok(frames.length>0);
 if(!process.argv.includes('--only-video')){
  for(const frame of frames){await renderStill({serveUrl,composition,frame,output:path.join(qa,`frame-${frame}.png`),imageFormat:'png',scale,puppeteerInstance:browser,onBrowserLog:log});console.log('Frame',frame);}
  for(const frame of repeatedFrames){
   const p=path.join(qa,`repeat-${frame}.png`);await renderStill({serveUrl,composition,frame,output:p,imageFormat:'png',scale,puppeteerInstance:browser,onBrowserLog:log});
   const matched=hash(p)===hash(path.join(qa,`frame-${frame}.png`));repeats.push({frame,matched});assert.ok(matched,`Frame ${frame} is history dependent`);
  }
  for(const [a,b]of motionPairs){
   const different=hash(path.join(qa,`frame-${a}.png`))!==hash(path.join(qa,`frame-${b}.png`));fractionalMotion.push({a,b,different});assert.ok(different,`Unexpected stationary motion frames at ${a}`);
  }
  const sampleDetails=['work','workspace','result','proof'].map(id=>inBounds(board.shots.find(s=>s.id===id).activeStart+Math.floor(board.shots.find(s=>s.id===id).activeFrames*.62)));
  const report={revision:board.revision,width,height,fps,durationInFrames:framesTotal,durationSeconds:board.runtimeSeconds,modelFixture:board.model,frames,scale,parity,repeats,fractionalMotion,errors,transitions:board.transitions,shots:board.shots.map(({id,title,activeStart,activeFrames})=>({id,title,activeStart,activeFrames})),cutCenters:board.transitions.map(t=>t.startFrame+Math.floor(t.frames/2)),intermediateImageFormat:'png'};
  fs.writeFileSync(path.join(qa,'render-report.json'),JSON.stringify(report,null,2));
  for(const frame of sampleDetails){await renderStill({serveUrl,composition,frame,output:path.join(qa,`detail-${frame}.png`),imageFormat:'png',scale:1,puppeteerInstance:browser,onBrowserLog:log});console.log('4K detail',frame);}
 }
 assert.equal(errors.length,0,JSON.stringify(errors));
 if(process.argv.includes('--video')||process.argv.includes('--only-video')){
  const range=process.env.FRAME_RANGE?.split(',').map(Number),frameRange=range?[range[0],range[1]]:undefined;
  const filename=frameRange?'OpenLink-4K-transition-test.mp4':'OpenLink-4K60-Paced-GPT-6-Luna.mp4';
  let last=-1;await renderMedia({serveUrl,composition,outputLocation:path.join(output,filename),codec:'h264',audioCodec:'aac',audioBitrate:'320k',crf:14,imageFormat:'png',pixelFormat:'yuv420p',concurrency:4,frameRange,puppeteerInstance:browser,onBrowserLog:log,onProgress:p=>{const n=Math.floor(p.progress*100);if(n>=last+5){last=n;console.log('4K render',n+'%');}}});
  assert.equal(errors.length,0,JSON.stringify(errors));
 }
 console.log('4K output:',output);
}finally{if(browser)await browser.close({silent:true});fs.rmSync(bundleDir,{recursive:true,force:true});}
