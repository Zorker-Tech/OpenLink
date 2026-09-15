// Offline GSAP timeline and Motion spring sampling: deterministic video, no RAF playback.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {gsap} from 'gsap';
import {spring} from 'motion';
const state={progress:0};
const timeline=gsap.timeline({paused:true}).fromTo(state,{progress:0},{progress:1,duration:1,ease:'power3.inOut',immediateRender:true},0);
const physics=spring({keyframes:[0,1],duration:800,bounce:.08});
const ease=[],settle=[];
for(let i=0;i<=1024;i++){timeline.totalTime(i/1024,true);ease.push(Number(state.progress.toFixed(7)));settle.push(Number(physics.next(i/1024*800).value.toFixed(7)));}
for(const i of [1000,128,768,0,512]){timeline.totalTime(i/1024,true);assert.ok(Math.abs(state.progress-ease[i])<1e-6);}
timeline.kill();gsap.ticker.sleep();
fs.writeFileSync('src/reference-film/motion-curves.json',JSON.stringify({ease,settle}));
fs.writeFileSync('provenance/motion-curves.json',JSON.stringify({gsap:'3.15.0',motion:'12.43.0',method:'Paused GSAP numeric timeline sampled with totalTime; Motion spring generator sampled at explicit milliseconds. All movie animation indexes these immutable curves by frame.',gsapEase:'power3.inOut',spring:{durationMs:800,bounce:.08},samples:1025,reverseSamplingPassed:true,docs:['https://gsap.com/docs/v3/GSAP/Timeline/totalTime()/','https://motion.dev/docs/spring']},null,2));
console.log('Built 1025 GSAP and Motion samples; reverse-seek check passed.');
