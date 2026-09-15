import fs from 'node:fs';
import {gsap} from 'gsap';
const definitions={
 intent:{duration:480,keys:[[-32,{x:960,y:540,zoom:1.08,focus:0,track:0,send:0,actorY:90,actorScale:.92}], [35,{zoom:1.4,actorY:0,actorScale:1},'power3.out'],[95,{zoom:2.6,focus:1,track:.24},'sine.inOut'],[245,{zoom:2.64,track:.28},'none'],[290,{zoom:2.58,track:0},'sine.inOut'],[390,{zoom:3.22,send:1},'power2.inOut'],[512,{zoom:3.26},'none']]},
 refinement:{duration:360,keys:[[-32,{x:960,y:540,zoom:1.12,focus:0,track:0,send:0,actorY:60,actorScale:.95}], [30,{actorY:0,actorScale:1,zoom:1.65},'power3.out'],[90,{zoom:3.3,focus:1},'power2.inOut'],[215,{zoom:3.35},'none'],[295,{send:1,zoom:3.62},'power2.inOut'],[392,{zoom:3.66},'none']]},
 execution:{duration:660,keys:[[-32,{x:960,y:560,zoom:2.02,actorY:25,actorScale:1}], [30,{actorY:0},'power2.out'],[140,{y:620,zoom:1.95},'sine.inOut'],[280,{y:710,zoom:2.02},'sine.inOut'],[420,{y:805,zoom:1.92},'sine.inOut'],[550,{y:930,zoom:2.02},'sine.inOut'],[692,{y:940,zoom:2.055},'none']]},
 artifact:{duration:360,keys:[[-32,{x:960,y:565,zoom:.94,actorY:90,actorScale:.94}], [55,{x:970,y:540,zoom:1,actorY:0,actorScale:1},'power3.out'],[285,{x:1012,y:515,zoom:1.065},'none'],[392,{x:1025,y:510,zoom:1.075},'sine.inOut']]},
 resolution:{duration:240,keys:[[-32,{x:1025,y:510,zoom:1.075,actorY:0,actorScale:1}], [115,{x:1060,y:495,zoom:1.09},'sine.inOut'],[272,{x:1120,y:470,zoom:1.12},'none']]},
 inspector:{duration:240,keys:[[-32,{x:1120,y:470,zoom:1.12,actorY:0,actorScale:1}], [85,{x:835,y:355,zoom:1.78},'power2.inOut'],[130,{x:834,y:353,zoom:1.8},'none'],[210,{x:960,y:540,zoom:1},'power2.inOut'],[272,{x:955,y:540,zoom:1.012},'none']]},
 diff:{duration:240,keys:[[-32,{x:960,y:540,zoom:1,actorY:80,actorScale:.84}], [38,{actorY:0,actorScale:1},'back.out(1.12)'],[272,{actorY:-12,actorScale:1.022},'none']]},
 versions:{duration:240,keys:[[-32,{x:960,y:540,zoom:1,actorY:65,actorScale:.9}], [35,{actorY:0,actorScale:1},'back.out(1.1)'],[150,{actorY:-5,actorScale:1.006},'none'],[272,{actorY:-10,actorScale:1.012},'none']]}
};
const tracks={};
for(const [name,def] of Object.entries(definitions)){
 const state={...def.keys[0][1]},tl=gsap.timeline({paused:true});
 for(let i=1;i<def.keys.length;i++){const [frame,vars,ease]=def.keys[i],prev=def.keys[i-1][0];tl.to(state,{...vars,duration:(frame-prev)/60,ease:ease||'sine.inOut'},(prev+32)/60);}
 const samples=[];for(let f=-32;f<=def.duration+32;f+=.5){tl.totalTime((f+32)/60,true);samples.push(Object.fromEntries(Object.entries(state).filter(([k])=>!k.startsWith('_')).map(([k,v])=>[k,Number(v.toFixed(6))])));}
 tracks[name]={start:-32,step:.5,samples};tl.kill();
}
gsap.ticker.sleep();fs.writeFileSync('src/reference-film/choreography.json',JSON.stringify(tracks));
fs.writeFileSync('provenance/choreography.json',JSON.stringify({engine:'GSAP 3.15.0 paused timelines',tracks:definitions,frameSampling:'half design frame, independent of playback history',scope:'camera and actor motion; native UI has separate scoped GSAP timelines'},null,2));
console.log('Generated dedicated GSAP choreography for',Object.keys(tracks).join(', '));
