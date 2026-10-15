import {bundle} from '@remotion/bundler';
import {enableTailwind} from '@remotion/tailwind-v4';
import {openBrowser,selectComposition,renderStill,renderMedia} from '@remotion/renderer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {inflateSync} from 'node:zlib';
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
function pixelDifference(fileA,fileB){
 const decode=file=>{
  const data=fs.readFileSync(file);assert.deepEqual([...data.subarray(0,8)],[137,80,78,71,13,10,26,10]);
  let width=0,height=0,depth=0,color=0;const parts=[];
  for(let p=8;p<data.length;){const len=data.readUInt32BE(p),type=data.toString('ascii',p+4,p+8),chunk=data.subarray(p+8,p+8+len);if(type==='IHDR'){width=chunk.readUInt32BE(0);height=chunk.readUInt32BE(4);depth=chunk[8];color=chunk[9];}if(type==='IDAT')parts.push(chunk);p+=12+len;}
  assert.equal(depth,8,'PNG pixel-depth audit');assert.ok(color===2||color===6,'PNG RGB/RGBA audit');
  const channels=color===6?4:3,stride=width*channels,raw=inflateSync(Buffer.concat(parts)),pixels=Buffer.alloc(height*stride),paeth=(a,b,c)=>{const p=a+b-c,aa=Math.abs(p-a),ab=Math.abs(p-b),ac=Math.abs(p-c);return aa<=ab&&aa<=ac?a:ab<=ac?b:c;};
  for(let y=0;y<height;y++){const source=y*(stride+1),target=y*stride,filter=raw[source];for(let x=0;x<stride;x++){const value=raw[source+1+x],left=x>=channels?pixels[target+x-channels]:0,up=y?pixels[target-stride+x]:0,upLeft=y&&x>=channels?pixels[target-stride+x-channels]:0;let predict=0;if(filter===1)predict=left;else if(filter===2)predict=up;else if(filter===3)predict=Math.floor((left+up)/2);else if(filter===4)predict=paeth(left,up,upLeft);else assert.equal(filter,0,'PNG scanline filter');pixels[target+x]=(value+predict)&255;}}
  return {width,height,channels,pixels};
 };
 const a=decode(fileA),b=decode(fileB);assert.deepEqual([a.width,a.height,a.channels],[b.width,b.height,b.channels]);
 let differingPixels=0,maxChannelDelta=0;for(let i=0;i<a.pixels.length;i+=a.channels){let changed=false;for(let channel=0;channel<a.channels;channel++){const delta=Math.abs(a.pixels[i+channel]-b.pixels[i+channel]);if(delta){changed=true;maxChannelDelta=Math.max(maxChannelDelta,delta);}}if(changed)differingPixels++;}
 return {differingPixels,maxChannelDelta,pixelCount:a.width*a.height};
}
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
  const diff=pixelDifference(path.join(qa,`Current${kind}Source.png`),path.join(qa,`Current${kind}Film.png`));
  const maxToleratedPixels=40,matched=diff.differingPixels<=maxToleratedPixels&&diff.maxChannelDelta<=1;
  parity.push({kind,matched,exact:diff.differingPixels===0,...diff,maxToleratedPixels});assert.ok(matched,kind+' composer differs from current extracted source presentation');console.log('Composer parity:',kind,matched,diff);
 }
 const transitionFrames=board.transitions.flatMap(t=>[t.startFrame-1,t.startFrame,t.startFrame+Math.floor(t.frames/2),t.startFrame+t.frames-1,t.startFrame+t.frames].map(inBounds));
 const shotSamples=board.shots.flatMap(s=>[.08,.25,.5,.75,.92].map(p=>inBounds(s.activeStart+s.activeFrames*p)));
 const repeatedFrames=[...new Set(board.shots.map(s=>inBounds(s.activeStart+Math.floor(s.activeFrames/2))))];
 const motionChecks=[['logo',50],['logo',51],['prompt',35],['prompt',36],['work',140],['work',141],['workspace',55],['workspace',56],['refine',30],['refine',31],['result',114],['result',115],['proof',35],['proof',37],['close',40],['close',41]];
 const motionPairs=motionChecks.reduce((all,entry,index)=>index%2?[...all, [frameAtSource(motionChecks[index-1][0],motionChecks[index-1][1]),frameAtSource(entry[0],entry[1])]]:all,[]);
 const frameList=process.env.FILM_FRAMES?[...process.env.FILM_FRAMES.split(',').map(Number),...motionPairs.flat(),...repeatedFrames]:[0,framesTotal-1,...shotSamples,...transitionFrames,...motionPairs.flat()];
 const frames=[...new Set(frameList.map(inBounds))].sort((a,b)=>a-b),scale=Number(process.env.QA_SCALE||.25),repeats=[],fractionalMotion=[];
 assert.ok(frames.length>0);
 if(!process.argv.includes('--only-video')){
  for(const frame of frames){await renderStill({serveUrl,composition,frame,output:path.join(qa,`frame-${frame}.png`),imageFormat:'png',scale,puppeteerInstance:browser,onBrowserLog:log});console.log('Frame',frame);}
  for(const frame of repeatedFrames){
   const p=path.join(qa,`repeat-${frame}.png`);await renderStill({serveUrl,composition,frame,output:p,imageFormat:'png',scale,puppeteerInstance:browser,onBrowserLog:log});
   const diff=pixelDifference(p,path.join(qa,`frame-${frame}.png`)),matched=diff.differingPixels===0;repeats.push({frame,matched,...diff});assert.ok(matched,`Frame ${frame} is history dependent`);
  }
  for(const [a,b]of motionPairs){
   const diff=pixelDifference(path.join(qa,`frame-${a}.png`),path.join(qa,`frame-${b}.png`)),different=diff.differingPixels>0;fractionalMotion.push({a,b,different,...diff});assert.ok(different,`Unexpected stationary motion frames at ${a}`);
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
