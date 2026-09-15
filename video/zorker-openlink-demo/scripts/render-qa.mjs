import {bundle} from '@remotion/bundler';
import {enableTailwind} from '@remotion/tailwind-v4';
import {openBrowser,selectComposition,renderStill} from '@remotion/renderer';
import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
fs.mkdirSync('out/qa',{recursive:true});
const serveUrl=await bundle({entryPoint:'src/index.ts',rspack:true,bundlerOverride:enableTailwind});
const browser=await openBrowser('chrome');
const composition=await selectComposition({serveUrl,id:'ZorkerOpenLink',puppeteerInstance:browser});
const frames=[60,350,650,900,1010,1260,1510,1720,149,150,151,394,395,396,449,450,451,749,750,751,779,780,781,1139,1140,1141,1169,1170,1171,1334,1335,1336,1469,1470,1471,1559,1560,1561,1799];
const errors=[];
for(const frame of frames) {
 await renderStill({serveUrl,composition,frame,output:`out/qa/${String(frame).padStart(4,'0')}.png`,imageFormat:'png',scale:.5,puppeteerInstance:browser,onBrowserLog:log=>{if(log.type==='error') errors.push(log.text);}});
}
const repeated=[];
for(const frame of [1260,900,350]) {
 const output=`out/qa/repeat-${frame}.png`;
 await renderStill({serveUrl,composition,frame,output,imageFormat:'png',scale:.5,puppeteerInstance:browser});
 const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
 const first=hash(`out/qa/${String(frame).padStart(4,'0')}.png`), second=hash(output);
 assert.equal(second,first,`frame ${frame} changed when requested out of order`);
 repeated.push({frame,sha256:first,matched:true});
}
assert.equal(errors.length,0);
fs.writeFileSync('out/qa/report.json',JSON.stringify({composition:composition.id,width:composition.width,height:composition.height,fps:composition.fps,durationInFrames:composition.durationInFrames,frames,repeated,browserErrors:errors},null,2));
await browser.close({silent:true});
console.log(`PASS: ${frames.length} sampled/boundary frames, three out-of-order image hash matches, zero browser errors.`);
