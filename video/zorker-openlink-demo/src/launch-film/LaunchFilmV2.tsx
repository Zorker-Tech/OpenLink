import {useEffect,useState} from 'react';
import type {ReactNode} from 'react';
import {AbsoluteFill,Audio,Img,Sequence,continueRender,delayRender,staticFile,useCurrentFrame,useVideoConfig} from 'remotion';
import {Cursor,Stage,reveal} from '../reference-film/primitives';
import {ClickPulse} from '../reference-film/Choreography';
import {useShotFrame} from '../reference-film/ShotClock';
import {NativePrompt,frontAt,type PromptGeometry} from '../reference-film/Native';
import {SourceChatTopbar,SourcePreviewCanvas,SourceTopbar,SourceVersionMenu} from '../reference-film/source/preview.js';
import {FilmCurrentUi} from '../reference-film/FilmLocale';
import {CurrentSessionComposer} from '../reference-film/current-ui/components/film-chat-composer.js';
import {LaunchV2ChangeCard,LaunchV2Timeline,LAUNCH_V2_QUESTION} from '../reference-film/LaunchV2Native';
import storyboard from './storyboard-v2.json';

type Shot={id:string;title:string;startSeconds:number;durationSeconds:number};
const shots=storyboard.shots as Shot[];
const shotById=(id:string)=>{const shot=shots.find((item)=>item.id===id);if(!shot)throw new Error('Missing V2 shot: '+id);return shot;};
const clamp=(value:number,min=0,max=1)=>Math.min(max,Math.max(min,value));
const ramp=(frame:number,start:number,end:number)=>clamp((frame-start)/(end-start));
const easeOut=(value:number)=>1-Math.pow(1-clamp(value),3);
const easeInOut=(value:number)=>value<.5?4*value*value*value:1-Math.pow(-2*value+2,3)/2;
const blue='#416BFF',orange='#F2764A';

function Segment({id,children}:{id:string;children:ReactNode}){
 const shot=shotById(id),{fps}=useVideoConfig();
 return <Sequence from={Math.round(shot.startSeconds*fps)} durationInFrames={Math.round(shot.durationSeconds*fps)} name={shot.title}>{children}</Sequence>;
}

function Mesh({tone='blue',children}:{tone?:'blue'|'peach'|'lavender';children:ReactNode}){
 const colors=tone==='peach'?['#ffe5d9','#fff6ed','#f4e5ff']:tone==='lavender'?['#e8e1ff','#f3f5ff','#ffdfe9']:['#dce4ff','#f4f7ff','#f8e6f5'];
 return <AbsoluteFill style={{overflow:'hidden',background:'radial-gradient(ellipse 64% 74% at 18% 24%,'+colors[0]+' 0%,transparent 70%),radial-gradient(ellipse 56% 72% at 82% 27%,'+colors[2]+' 0%,transparent 70%),linear-gradient(145deg,'+colors[1]+',#fff 72%)'}}>{children}</AbsoluteFill>;
}

function V2Disclosure({dark=false}:{dark?:boolean}){
 return <div style={{position:'absolute',bottom:26,left:52,fontSize:20,letterSpacing:.1,color:dark?'#ffffff9c':'#737987'}}>Illustrative workflow · Dash XV demo project</div>;
}

function OpeningRun(){
 const f=useShotFrame(),slot=1100,travel=f*slot/66,slide=easeInOut(ramp(f,390,448));
 const lines=[
  {text:'Founders.',color:'#7563DA'},
  {text:'Designers.',color:'#D65C9D'},
  {text:'Product teams.',color:'#209B77'},
  {text:'Developers.',color:'#D48B35'},
  {text:'Everyone.',color:blue,tail:'We can move ideas forward.'},
  {prefix:'With ',text:'Zorker.',color:orange},
  {prefix:'With ',text:'OpenLink.',color:blue},
 ];
 return <Stage><div style={{position:'absolute',inset:0,overflow:'hidden',background:'#fff'}}>
  <div style={{position:'absolute',left:0,top:0,width:8800,height:1080,transform:'translateX('+(410-travel)+'px)'}}>
   {lines.map((line,index)=><div key={line.text} style={{position:'absolute',left:index*slot,top:0,width:slot,height:1080,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',whiteSpace:'nowrap',fontSize:index===4?88:98,lineHeight:1.08,fontWeight:620,letterSpacing:-5.2,color:'#17191D'}}>
    {line.prefix&&<span>{line.prefix}<span style={{color:line.color}}>{line.text}</span></span>}
    {!line.prefix&&<span style={{color:line.color}}>{line.text}</span>}
    {line.tail&&<span style={{marginTop:17,fontSize:49,fontWeight:500,letterSpacing:-1.9}}>{line.tail}</span>}
   </div>)}
   <div style={{position:'absolute',left:7*slot,top:0,width:slot,height:1080,display:'flex',alignItems:'center',justifyContent:'center'}}>
    <div style={{width:650,height:104,position:'relative',display:'flex',alignItems:'center',borderRadius:54,background:'#F0F1F4',padding:8,boxShadow:'inset 0 1px 3px #0000000D'}}>
     <div style={{position:'absolute',left:8+slide*318,top:8,bottom:8,width:318,borderRadius:42,background:'#fff',boxShadow:'0 4px 16px #10182818'}}/>
     <div style={{position:'relative',zIndex:1,width:'50%',textAlign:'center',fontSize:31,fontWeight:570,color:slide<.5?'#20232A':'#737987'}}>Idea</div>
     <div style={{position:'relative',zIndex:1,width:'50%',textAlign:'center',fontSize:31,fontWeight:570,color:slide>=.5?'#20232A':'#737987'}}>Working build</div>
    </div>
   </div>
  </div>
 </div></Stage>;
}

function Thesis(){
 const f=useShotFrame(),p=reveal(f,0,17);
 return <Stage><div style={{position:'absolute',left:170,right:170,top:392,textAlign:'center',fontSize:83,lineHeight:1.13,fontWeight:590,letterSpacing:-4.5,opacity:p,transform:'translateY('+(1-p)*22+'px)',color:'#17191D'}}>Every new product begins with a question.</div></Stage>;
}

function Ask(){
 const f=useShotFrame(),count=Math.floor(clamp((f-24)/226)*LAUNCH_V2_QUESTION.length);
 const [g,setG]=useState<PromptGeometry>({x:16,y:34,h:22,startX:16,fullWidth:650,submitX:900,submitY:118,fronts:[]});
 const x=470,y=370,width=980,rawSubmitX=x+g.submitX,rawSubmitY=y+g.submitY;
 const push=1+.027*ramp(f,75,285),sx=960+(rawSubmitX-960)*push,sy=540+(rawSubmitY-540)*push;
 const cursorFrame=(f-242)/42,cursorX=1480+(sx-8-1480)*easeOut(cursorFrame),cursorY=875+(sy-6-875)*easeOut(cursorFrame);
 const pressed=f>=272&&f<290?Math.sin((f-272)/18*Math.PI):0;
 return <Mesh tone="blue"><div style={{position:'absolute',left:x,top:y,width,transform:'translateY('+(1-easeOut(ramp(f,0,34)))*58+'px) scale('+(1+.012*ramp(f,0,35))+')',transformOrigin:'50% 50%'}}>
  <NativePrompt kind="home" width={width} text={LAUNCH_V2_QUESTION.slice(0,count)} fullText={LAUNCH_V2_QUESTION} caret={f>=24&&f<266} onGeometry={setG} animationFrame={f} clickFrame={272}/>
 </div>
 <div style={{position:'absolute',inset:0,pointerEvents:'none',transform:'translate(0,0)'}}/>
 <Cursor x={cursorX} y={cursorY} opacity={f>=236&&f<305?Math.min(1,ramp(f,236,250),1-ramp(f,287,305)):0} pressed={pressed}/>
 <ClickPulse x={sx} y={sy} f={f} start={272}/><V2Disclosure/>
 </Mesh>;
}

function Work(){
 const f=useShotFrame(),p=easeOut(ramp(f,0,24));
 return <Mesh tone="lavender"><div style={{position:'absolute',left:352,top:112,width:1216,height:872,overflow:'hidden',borderRadius:19,background:'#fff',border:'1px solid #20283812',boxShadow:'0 34px 96px #23304C24',opacity:p,transform:'translateY('+(1-p)*40+'px)'}}>
   <SourceChatTopbar title="Dash XV · Mobile purchase flow"/>
   <LaunchV2Timeline frame={f} width={1216} height={820}/>
  </div>
  <div style={{position:'absolute',right:360,top:72,fontSize:20,fontWeight:550,letterSpacing:1.2,color:'#6F7280'}}>OPENLINK · WORKING</div>
  <V2Disclosure/>
 </Mesh>;
}

function FoldDiagram(){
 return <svg width="540" height="350" viewBox="0 0 540 350" role="img" aria-label="The buy button sits below the mobile viewport">
  <rect x="92" y="18" width="238" height="308" rx="25" fill="#fff" stroke="#D9DDE5" strokeWidth="3"/>
  <rect x="107" y="39" width="208" height="259" rx="15" fill="#F6F7F9"/>
  <rect x="125" y="58" width="62" height="10" rx="5" fill="#242834"/>
  <rect x="125" y="85" width="172" height="86" rx="9" fill="#E4E8F0"/>
  <path d="M143 144c17-34 39-47 62-40l21 9 18 28c5 7 20 9 32 12l7 14H137z" fill="#fff" stroke="#9298A5" strokeWidth="2"/>
  <path d="M131 189h45m12 0h45m12 0h45" stroke="#B3B8C3" strokeWidth="12" strokeLinecap="round"/>
  <rect x="129" y="208" width="47" height="27" rx="7" fill="#fff" stroke={blue} strokeWidth="2"/>
  <rect x="184" y="208" width="47" height="27" rx="7" fill={blue}/>
  <rect x="239" y="208" width="47" height="27" rx="7" fill="#fff" stroke="#C8CDD7" strokeWidth="2"/>
  <text x="207" y="227" fill="#fff" textAnchor="middle" fontSize="14" fontFamily="sans-serif" fontWeight="700">09</text>
  <path d="M116 244h190" stroke="#F2764A" strokeDasharray="6 7" strokeWidth="2.5"/>
  <text x="340" y="240" fill="#7A808C" fontSize="15" fontFamily="sans-serif" letterSpacing="1">VIEWPORT</text>
  <path d="M324 244h27" stroke="#7A808C" strokeWidth="1.5"/>
  <rect x="127" y="265" width="168" height="31" rx="8" fill={orange}/>
  <text x="211" y="286" fill="#fff" textAnchor="middle" fontSize="14" fontFamily="sans-serif" fontWeight="700">ADD TO BAG</text>
  <path d="M367 273c21-4 32-16 32-34" fill="none" stroke={orange} strokeWidth="2.2"/>
  <path d="m393 237 6 3-5 5" fill="none" stroke={orange} strokeWidth="2.2"/>
  <text x="376" y="295" fill="#B85B3D" fontSize="17" fontFamily="sans-serif" fontWeight="600">below the fold</text>
 </svg>;
}

function Answer(){
 const f=useShotFrame(),p=easeOut(ramp(f,12,28)),q=easeOut(ramp(f,24,69));
 return <Stage><div style={{position:'absolute',left:190,right:190,top:134,textAlign:'center',fontSize:72,lineHeight:1.1,fontWeight:540,letterSpacing:-3.8,color:'#191B20',opacity:p,transform:'translateY('+(1-p)*16+'px)'}}>
   <div>The choice worked.</div><div style={{color:'#686F7B',fontSize:58,marginTop:12}}>The buy action fell below the mobile viewport.</div>
  </div>
  <div style={{position:'absolute',left:690,top:555,opacity:q,transform:'translateY('+(1-q)*24+'px) scale('+(0.97+.03*q)+')',transformOrigin:'50% 50%'}}><FoldDiagram/></div>
 </Stage>;
}

function InsightCard(){
 const f=useShotFrame(),p=easeOut(ramp(f,318,380)),zoom=1+.035*ramp(f,400,446);
 return <Stage><div style={{position:'absolute',inset:0,display:'flex',alignItems:'center',justifyContent:'center'}}>
   <div style={{width:1180,minHeight:430,padding:'54px 70px 58px',boxSizing:'border-box',borderRadius:28,background:'#fff',boxShadow:'0 28px 86px #1C253B12',border:'1px solid #232B3B0D',opacity:p,transform:'translateY('+(1-p)*42+'px) scale('+zoom+')',transformOrigin:'50% 50%',display:'flex',alignItems:'center',gap:52}}>
    <div style={{flex:1}}>
     <div style={{fontSize:18,fontWeight:620,letterSpacing:1.7,textTransform:'uppercase',color:blue,marginBottom:19}}>The product insight</div>
     <div style={{fontSize:54,lineHeight:1.08,fontWeight:580,letterSpacing:-2.8,color:'#17191D'}}>The choice and the next step had lost context.</div>
     <div style={{fontSize:25,lineHeight:1.45,color:'#6D727C',marginTop:21}}>Keep the selected size visible. Keep the purchase action beside it.</div>
    </div>
    <div style={{width:320,height:250,position:'relative',flexShrink:0,display:'flex',flexDirection:'column',justifyContent:'center',gap:15}}>
     <div style={{padding:'18px 22px',borderRadius:16,border:'1px solid #DDE1E8',background:'#F7F8FA',fontSize:23,color:'#313641'}}>Size 09 selected <span style={{float:'right',color:blue}}>✓</span></div>
     <div style={{height:2,marginLeft:26,width:3,background:'linear-gradient(#A9B2C7,#A9B2C7)',position:'relative'}}/>
     <div style={{padding:'20px 22px',borderRadius:16,background:blue,color:'#fff',fontSize:22,fontWeight:620,boxShadow:'0 12px 28px #416BFF33'}}>Add to bag <span style={{float:'right'}}>→</span></div>
     <div style={{position:'absolute',left:0,right:0,top:122,borderTop:'1px dashed #F2764A',opacity:.65}}/>
    </div>
   </div>
  </div>
 </Stage>;
}

function Why(){
 const f=useShotFrame();
 if(f>=318)return <InsightCard/>;
 let phrase='Not just what changed.';
 if(f>=90&&f<174)phrase='Not just how.';
 if(f>=174)phrase='But';
 const why=ramp(f,174,194),settle=ramp(f,210,230);
 const whyScale=1+(1-settle)*Math.min(1,why*1.85)*1.15;
 const whyOpacity=f<174?0:1;
 const p=easeOut(ramp(f,0,22));
 return <Stage><div style={{position:'absolute',left:0,right:0,top:382,textAlign:'center',opacity:p,transform:'translateY('+(1-p)*17+'px)',fontSize:94,lineHeight:1.08,fontWeight:570,letterSpacing:-5,color:'#17191D'}}>
   {phrase}{f>=174&&<span style={{display:'inline-block',marginLeft:21,color:blue,transform:'scaleX('+whyScale+')',transformOrigin:'left center',opacity:whyOpacity}}>why</span>}
  </div>
  {f>=226&&<div style={{position:'absolute',left:0,right:0,top:544,textAlign:'center',fontSize:31,color:'#666D78',opacity:easeOut(ramp(f,226,244))}}>The choice stayed. The next step drifted out of reach.</div>}
 </Stage>;
}

type Palette={name:string;paper:string;ink:string;muted:string;accent:string;upper:string;sole:string;line:string;soft:string};
const palettes:Record<string,Palette>={
 warm:{name:'Warm / Clay',paper:'#F5F0E7',ink:'#24241F',muted:'#74746F',accent:'#E97352',upper:'#EAE7DD',sole:'#FAF8F0',line:'#D8D2C6',soft:'#EAE4D8'},
 sky:{name:'Electric / Sky',paper:'#EBF0FF',ink:'#1D2D4B',muted:'#62718A',accent:'#416BFF',upper:'#F7F9FF',sole:'#FFFFFF',line:'#CBD7FF',soft:'#DCE5FF'},
 citrus:{name:'Citrus / Chalk',paper:'#FAF7E9',ink:'#28281F',muted:'#74715E',accent:'#B9B536',upper:'#F1EFD9',sole:'#FFFDF2',line:'#E2DDAF',soft:'#F0EDCD'},
};

function SneakerArt({accent,upper,sole}:{accent:string;upper:string;sole:string}){
 return <svg width="100%" height="100%" viewBox="0 0 800 390" aria-hidden="true">
  <defs>
   <linearGradient id="shoe-upper" x1="120" y1="100" x2="692" y2="332" gradientUnits="userSpaceOnUse"><stop stopColor={upper}/><stop offset=".56" stopColor="#ffffff"/><stop offset="1" stopColor={upper}/></linearGradient>
   <linearGradient id="shoe-sole" x1="130" y1="300" x2="706" y2="343" gradientUnits="userSpaceOnUse"><stop stopColor={sole}/><stop offset="1" stopColor="#D5D8DF"/></linearGradient>
   <filter id="shoe-shadow" x="50" y="52" width="720" height="310" filterUnits="userSpaceOnUse"><feGaussianBlur stdDeviation="13"/></filter>
  </defs>
  <ellipse cx="410" cy="314" rx="306" ry="27" fill="#23304A" opacity=".11" filter="url(#shoe-shadow)"/>
  <path d="M88 278c19-35 55-75 104-97l92-39c47-18 89-45 126-74 22-17 45-15 59 4l69 92c18 24 47 40 86 48l78 17c30 7 49 26 48 50-1 24-21 39-52 40l-552 7c-47 1-76-19-58-48Z" fill="url(#shoe-upper)" stroke="#7E8490" strokeWidth="3.5" strokeLinejoin="round"/>
  <path d="M88 278c42 18 114 25 190 15l293-22c73-6 129 7 179 24 1 22-18 37-52 38l-552 7c-47 1-76-19-58-48Z" fill="url(#shoe-sole)" stroke="#7D838F" strokeWidth="3.5" strokeLinejoin="round"/>
  <path d="M118 284c78 20 165 13 253 4 136-13 264-24 369-1" fill="none" stroke={accent} strokeWidth="8" strokeLinecap="round"/>
  <path d="M117 278c18-30 44-55 77-72l37 24-52 68-62-2Z" fill="#C9D1DE" stroke="#858D9A" strokeWidth="3"/>
  <path d="m231 224 74-64c20-18 49-29 82-44l55 17-38 109-148 49-64-67Z" fill={accent} opacity=".93"/>
  <path d="m231 224 56 14 41-49 60 16 28-72 27 36-35 96-148 26-64-67Z" fill="url(#shoe-upper)" stroke="#7E8490" strokeWidth="3" strokeLinejoin="round"/>
  <path d="m339 194 68-6m-80 27 78-5m-88 26 79-6" stroke="#717987" strokeWidth="6" strokeLinecap="round"/>
  <path d="m416 147 60 30m-77-5 67 33m-82-8 71 34" stroke="#596274" strokeWidth="5" strokeLinecap="round"/>
  <path d="M504 165c32 12 59 38 73 66l24 49-61 4-60-89 24-30Z" fill="#D5DCE7" stroke="#7E8490" strokeWidth="3"/>
  <path d="m466 184 42 21-34 56-47-18 39-59Z" fill="#FFFFFF" stroke="#838B98" strokeWidth="3"/>
  <path d="m154 258 37 11m-46 5 31 9" stroke="#F9FAFC" strokeWidth="6" strokeLinecap="round"/>
  <circle cx="263" cy="260" r="7" fill={accent}/><circle cx="283" cy="267" r="5" fill={accent} opacity=".55"/>
  <path d="M147 322h85m31-2h23m297-14 51 4m25 1 28 3" stroke="#B0B6C0" strokeWidth="4" strokeLinecap="round" opacity=".7"/>
 </svg>;
}

function MobileArtifact({palette='warm',width=560,height=920,scale=1,showLabel=false}:{palette?:keyof typeof palettes;width?:number;height?:number;scale?:number;showLabel?:boolean}){
 const c=palettes[palette];
 return <div style={{width,height,position:'relative',overflow:'hidden',borderRadius:34,background:c.paper,color:c.ink,border:'1px solid '+c.line,boxShadow:'0 38px 120px #11182733',transform:'scale('+scale+')',transformOrigin:'50% 50%',fontFamily:'OpenLinkGeist, sans-serif'}}>
  <div style={{position:'absolute',left:34,right:34,top:24,height:54,display:'flex',alignItems:'center',justifyContent:'space-between',borderBottom:'1px solid '+c.line}}>
   <div style={{fontSize:20,fontWeight:730,letterSpacing:1.7}}>DASH <span style={{fontWeight:410,color:c.muted}}>/ RUN SYSTEMS</span></div>
   <div style={{display:'flex',gap:7,alignItems:'center',fontSize:14,fontWeight:560,letterSpacing:1,color:c.muted}}>MENU <span style={{fontSize:23,color:c.ink}}>≡</span></div>
  </div>
  <div style={{position:'absolute',left:34,right:34,top:99,fontSize:14,fontWeight:580,letterSpacing:1.7,color:c.muted}}>RUN / SERIES 01 <span style={{float:'right'}}>01 — 04</span></div>
  <div style={{position:'absolute',left:22,right:22,top:115,height:300,opacity:.96}}>
   <SneakerArt accent={c.accent} upper={c.upper} sole={c.sole}/>
  </div>
  <div style={{position:'absolute',left:34,right:34,top:418}}>
   <div style={{display:'flex',alignItems:'baseline',justifyContent:'space-between'}}>
    <div style={{fontSize:55,fontWeight:690,letterSpacing:-3.6,lineHeight:1}}>DASH XV</div>
    <div style={{fontSize:17,fontWeight:650,letterSpacing:.2}}>$120</div>
   </div>
   <div style={{fontSize:18,color:c.muted,marginTop:10,letterSpacing:.1}}>Light in motion. Built for the longer run.</div>
   <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginTop:24}}>
    <div style={{fontSize:13,fontWeight:660,letterSpacing:1.3}}>COLOR <span style={{fontWeight:430,color:c.muted}}> / CLOUD</span></div>
    <div style={{display:'flex',gap:8}}><i style={{width:14,height:14,borderRadius:50,background:c.accent,display:'block',boxShadow:'0 0 0 3px '+c.paper+',0 0 0 4px '+c.ink}}/><i style={{width:14,height:14,borderRadius:50,background:'#DAD8D2',display:'block'}}/><i style={{width:14,height:14,borderRadius:50,background:'#32363D',display:'block'}}/></div>
   </div>
   <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginTop:20}}>
    <div style={{fontSize:14,fontWeight:670,letterSpacing:1.1}}>SELECT SIZE</div>
    <div style={{fontSize:12,color:c.muted}}>SIZE GUIDE ↗</div>
   </div>
   <div style={{display:'flex',gap:7,marginTop:10}}>
    {['07','08','09','10','11'].map((size)=>{const selected=size==='09';return <div key={size} style={{width:66,height:42,borderRadius:8,display:'flex',alignItems:'center',justifyContent:'center',fontSize:17,fontWeight:selected?650:480,background:selected?c.accent:'transparent',color:selected?'#fff':c.ink,border:'1px solid '+(selected?c.accent:c.line)}}>{size}</div>;})}
   </div>
   <div style={{fontSize:14,color:c.muted,marginTop:13}}>Size 09 selected</div>
  </div>
  <div style={{position:'absolute',left:0,right:0,bottom:0,height:116,padding:'15px 24px 19px',boxSizing:'border-box',background:c.paper,borderTop:'1px solid '+c.line,boxShadow:'0 -12px 32px '+c.paper+'CC',display:'flex',alignItems:'center',gap:15}}>
   <div style={{width:135}}>
    <div style={{fontSize:12,color:c.muted,letterSpacing:1}}>YOUR SIZE</div>
    <div style={{fontSize:20,fontWeight:650,marginTop:3}}>09 · $120</div>
   </div>
   <div style={{flex:1,height:58,borderRadius:12,background:c.accent,color:'#fff',display:'flex',alignItems:'center',justifyContent:'center',fontSize:17,fontWeight:690,letterSpacing:.7,boxShadow:'0 8px 18px '+c.accent+'44'}}>ADD TO BAG <span style={{marginLeft:12,fontSize:21}}>→</span></div>
  </div>
  {showLabel&&<div style={{position:'absolute',left:19,top:70,padding:'7px 11px',background:'#ffffffd9',color:c.ink,borderRadius:8,fontSize:12,fontWeight:650,letterSpacing:.7}}>DEMO · FICTIONAL PRODUCT</div>}
 </div>;
}

function Action(){
 const f=useShotFrame(),copyOpacity=1-ramp(f,90,135),cardIn=easeOut(ramp(f,96,142)),pageIn=easeOut(ramp(f,344,398));
 const clickFrame=377,pressed=f>=clickFrame&&f<clickFrame+18?Math.sin((f-clickFrame)/18*Math.PI):0;
 const cursorIn=easeOut(ramp(f,345,373)),cursorX=1550+(1120-1550)*cursorIn,cursorY=845+(633-845)*cursorIn;
 return <Mesh tone="blue"><div style={{position:'absolute',left:0,right:0,top:140,textAlign:'center',fontSize:70,lineHeight:1.15,fontWeight:560,letterSpacing:-3.6,color:'#17191D',opacity:copyOpacity,transform:'translateY('+(1-copyOpacity)*-15+'px)'}}>
   <div>Keep the next step in view.</div><div style={{fontSize:43,color:'#676E7A',marginTop:12}}>Pin the buy action to the selected size.</div>
  </div>
  <div style={{position:'absolute',left:155,top:302,transform:'translateY('+(1-cardIn)*30+'px)',opacity:cardIn}}>
   <div style={{position:'absolute',left:-18,top:-45,fontSize:17,fontWeight:650,letterSpacing:1.6,color:'#5E6572'}}>SRC / APP / PRODUCT / PAGE.TSX</div>
   <div style={{transform:'scale(1.28)',transformOrigin:'top left'}}><LaunchV2ChangeCard animationFrame={f}/></div>
  </div>
  <div style={{position:'absolute',left:1245,top:257,opacity:pageIn,transform:'translateY('+(1-pageIn)*24+'px) scale(.69)',transformOrigin:'top left'}}>
   <MobileArtifact palette="sky" width={560} height={920} showLabel/>
  </div>
  <Cursor x={cursorX} y={cursorY} opacity={f>=343&&f<421?Math.min(1,ramp(f,343,356),1-ramp(f,399,421)):0} pressed={pressed}/>
  <ClickPulse x={1120} y={633} f={f} start={clickFrame}/>
  <div style={{position:'absolute',right:160,top:838,fontSize:16,fontWeight:580,letterSpacing:.8,color:'#5B6475',opacity:pageIn}}>ONE MOBILE CHANGE · SAME PROJECT</div>
  <V2Disclosure/>
 </Mesh>;
}

function Result(){
 const f=useShotFrame(),move=easeInOut(ramp(f,0,112)),textX=-move*1110,pageX=1840-move*1005;
 return <Stage style={{background:'#101218',color:'#F8F8F6'}}>
  <div style={{position:'absolute',left:94,top:395,width:900,fontSize:99,lineHeight:1.02,fontWeight:560,letterSpacing:-5.5,transform:'translateX('+textX+'px)',opacity:1-ramp(f,73,112)}}>
   <div>One choice.</div><div style={{color:'#C4CBDA'}}>One next step.</div>
  </div>
  <div style={{position:'absolute',left:pageX,top:74}}>
   <MobileArtifact palette="warm" width={600} height={932} showLabel/>
  </div>
  <div style={{position:'absolute',right:70,top:40,fontSize:16,fontWeight:560,letterSpacing:1.5,color:'#FFFFFF9C',opacity:move}}>DASH XV · MOBILE PRODUCT PAGE</div>
  <V2Disclosure dark/>
 </Stage>;
}

function ThemeCard({palette,alpha,labelOpacity,parallax}:{palette:keyof typeof palettes;alpha:number;labelOpacity:number;parallax:number}){
 const c=palettes[palette];
 const background='radial-gradient(ellipse 64% 68% at 22% 18%,'+c.soft+' 0%,transparent 68%),linear-gradient(145deg,'+c.paper+',#FFFFFF 80%)';
 return <AbsoluteFill style={{opacity:alpha,background,overflow:'hidden'}}>
  <div style={{position:'absolute',left:160,top:212,width:610}}>
   <div style={{fontSize:20,fontWeight:660,letterSpacing:1.8,textTransform:'uppercase',color:c.accent,opacity:labelOpacity}}>One structure. A different voice.</div>
   <div style={{fontSize:61,lineHeight:1.04,fontWeight:560,letterSpacing:-3.2,color:c.ink,marginTop:23}}>Make it<br/>feel like you.</div>
   <div style={{fontSize:23,lineHeight:1.5,color:c.muted,marginTop:22}}>The same mobile flow, ready for your brand.</div>
   <div style={{display:'flex',gap:12,marginTop:34}}>
    {['Warm / Clay','Electric / Sky','Citrus / Chalk'].map((name)=>{const active=name===c.name;return <div key={name} style={{padding:'10px 14px',borderRadius:25,border:'1px solid '+(active?c.accent:c.line),background:active?c.accent+'14':'#ffffff80',fontSize:14,fontWeight:active?640:480,color:active?c.ink:c.muted}}>{name}</div>;})}
   </div>
  </div>
  <div style={{position:'absolute',left:958,top:61,transform:'translateY('+(parallax*10)+'px)'}}>
   <MobileArtifact palette={palette} width={560} height={900} showLabel/>
  </div>
  <div style={{position:'absolute',right:61,bottom:34,fontSize:16,letterSpacing:1.1,color:'#626A78'}}>SAME PAGE · SAME FLOW · NEW PALETTE</div>
 </AbsoluteFill>;
}

function Themes(){
 const f=useShotFrame(),warmAlpha=1-ramp(f,82,172),skyAlpha=ramp(f,82,172)*(1-ramp(f,250,340)),citrusAlpha=ramp(f,250,340);
 const parallax=0.5+Math.sin(f*.023)*.5,labelOpacity=easeOut(ramp(f,24,50));
 return <AbsoluteFill style={{background:'#F7F8FC'}}>
  <ThemeCard palette="warm" alpha={warmAlpha} labelOpacity={labelOpacity} parallax={parallax}/>
  <ThemeCard palette="sky" alpha={skyAlpha} labelOpacity={labelOpacity} parallax={parallax}/>
  <ThemeCard palette="citrus" alpha={citrusAlpha} labelOpacity={labelOpacity} parallax={parallax}/>
  <V2Disclosure/>
 </AbsoluteFill>;
}

const reviewVersions=[
 {ref:'d4a15c7-review',shortRef:'d4a15c7',message:'Keep the mobile buy action in view',current:true},
 {ref:'9bf20a1-base',shortRef:'9bf20a1',message:'Dash XV product page foundation',current:false},
];

function Review(){
 const f=useShotFrame(),menuIn=easeOut(ramp(f,98,125)),cursorIn=easeOut(ramp(f,170,205));
 const promptMenuX=1492,promptMenuY=244,cursorX=1740+(promptMenuX-1740)*cursorIn,cursorY=827+(promptMenuY-827)*cursorIn;
 const pressed=f>=212&&f<232?Math.sin((f-212)/20*Math.PI):0;
 return <Mesh tone="blue"><div style={{position:'absolute',left:139,top:58,width:1642,height:916,overflow:'hidden',borderRadius:15,border:'1px solid #20283820',boxShadow:'0 32px 100px #1B2B5026',background:'#fff'}}>
  <SourceTopbar/>
  <div style={{height:866,display:'flex',minWidth:0}}>
   <aside style={{width:424,flexShrink:0,display:'flex',flexDirection:'column',borderRight:'1px solid var(--app-border)',overflow:'hidden'}}>
    <SourceChatTopbar title="Dash XV · Mobile purchase flow"/>
    <div style={{flex:1,minHeight:0,overflow:'hidden'}}><LaunchV2Timeline frame={720} width={424} height={792}/></div>
    <FilmCurrentUi><div style={{padding:'7px 8px'}}><CurrentSessionComposer text=""/></div></FilmCurrentUi>
   </aside>
   <main style={{flex:1,minWidth:0}}>
    <SourcePreviewCanvas address="dash-xv.demo" selectedGitRef="d4a15c7-review" gitVersions={reviewVersions}>
     <div style={{height:'100%',width:'100%',display:'flex',alignItems:'center',justifyContent:'center',background:'#F5F0E7'}}>
      <div style={{transform:'scale(.74)',transformOrigin:'50% 50%'}}><MobileArtifact palette="warm" width={560} height={900} showLabel/></div>
     </div>
    </SourcePreviewCanvas>
   </main>
  </div>
  <div style={{position:'absolute',right:20,top:91,opacity:menuIn,transform:'translateY('+(1-menuIn)*-8+'px)'}}>
   <SourceVersionMenu selectedGitRef="d4a15c7-review" gitVersions={reviewVersions}/>
  </div>
 </div>
 <Cursor x={cursorX} y={cursorY} opacity={f>=166&&f<222?Math.min(1,ramp(f,166,181),1-ramp(f,212,222)):0} pressed={pressed}/>
 <ClickPulse x={promptMenuX} y={promptMenuY} f={f} start={212}/>
 <div style={{position:'absolute',left:158,top:1002,fontSize:20,color:'#596273',letterSpacing:.5,opacity:1-ramp(f,320,350)}}>Review-ready project state</div>
 <V2Disclosure/>
 </Mesh>;
}

function Close(){
 const f=useShotFrame(),copy=reveal(f,0,16)*(1-ramp(f,150,174)),brand=easeOut(ramp(f,190,232)),dot=ramp(f,150,205);
 const dotSize=14+dot*2200,dotOpacity=1-ramp(f,200,228);
 return <Stage><div style={{position:'absolute',left:190,right:190,top:390,textAlign:'center',fontSize:78,lineHeight:1.13,fontWeight:530,letterSpacing:-4.4,opacity:copy,transform:'translateY('+(1-copy)*16+'px)',color:'#17191D'}}>
   <div>Now anyone can turn a question</div><div>into a working product.</div>
  </div>
  <div style={{position:'absolute',left:960,top:540,width:dotSize,height:dotSize,borderRadius:'50%',background:orange,opacity:dotOpacity,transform:'translate(-50%,-50%)',filter:'blur('+(dot*1.5)+'px)'}}/>
  <div style={{position:'absolute',left:0,right:0,top:400,display:'flex',justifyContent:'center',opacity:brand,transform:'translateY('+(1-brand)*15+'px)'}}>
   <div style={{display:'flex',alignItems:'center',gap:26}}>
    <Img src={staticFile('brand/zorker-logo-dark.svg')} style={{width:140,height:84,objectFit:'contain'}}/>
    <div style={{fontSize:86,fontWeight:590,letterSpacing:-5,color:'#17191D'}}>Zorker <span style={{color:blue,fontWeight:450}}>OpenLink</span></div>
   </div>
  </div>
 </Stage>;
}

function EndBlack(){
 const length=storyboard.master.durationInFrames;
 const frame=useCurrentFrame();
 const opacity=frame>=length-4?1:0;
 return <AbsoluteFill style={{background:'#000',opacity:opacity,pointerEvents:'none'}}/>;
}

export function LaunchFilmV2(){
 const {width}=useVideoConfig();
 const [fontHandle]=useState(()=>delayRender('Load local brand font for OpenLink launch film V2'));
 useEffect(()=>{document.fonts.load('500 32px OpenLinkGeist').then(()=>continueRender(fontHandle));},[fontHandle]);
 return <AbsoluteFill className="film reference-film launch-film-v2" style={{background:'#fff',fontFamily:'OpenLinkGeist, sans-serif'}}>
  <Audio src={staticFile('audio/openlink-launch-v2.wav')}/>
  <div style={{position:'absolute',width:1920,height:1080,zoom:width/1920,overflow:'hidden'}}>
   <Segment id="opening"><OpeningRun/></Segment>
   <Segment id="thesis"><Thesis/></Segment>
   <Segment id="ask"><Ask/></Segment>
   <Segment id="thinking"><Work/></Segment>
   <Segment id="answer"><Answer/></Segment>
   <Segment id="why"><Why/></Segment>
   <Segment id="action"><Action/></Segment>
   <Segment id="result"><Result/></Segment>
   <Segment id="themes"><Themes/></Segment>
   <Segment id="review"><Review/></Segment>
   <Segment id="close"><Close/></Segment>
  </div>
  <EndBlack/>
 </AbsoluteFill>;
}
