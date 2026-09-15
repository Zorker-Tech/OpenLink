import {ArrowUpRight} from 'lucide-react';
import {interpolateColors} from 'remotion';
import type {CSSProperties} from 'react';
export const SampleSite=({blue=false,paletteProgress}:{blue?:boolean;paletteProgress?:number})=>{
 const p=Math.max(0,Math.min(1,paletteProgress??Number(blue)));
 const style=paletteProgress===undefined?undefined:Object.fromEntries([
  ['--forma-bg','#eeeae2','#edf0ff'],['--forma-fg','#272922','#112763'],['--forma-cta','#292d25','#254af3'],['--forma-art','#d6d2c7','#d6ddff'],['--forma-arch','#b0b0a0','#5270fa'],['--forma-arch-two','#969987','#254af3'],
 ].map(([key,a,b])=>[key,interpolateColors(p,[0,1],[a,b])])) as CSSProperties;
 return <div className={`demo-page ${blue?'blue':''}`} style={style}>
  <nav className="site-nav"><span className="site-name">forma<span style={{opacity:.4}}>®</span></span><div style={{display:'flex',gap:22}}><span>Projects</span><span>Studio</span><span>Contact ↗</span></div></nav>
  <div className="site-content"><div><div className="site-kicker">Independent architecture studio</div><h2 className="site-title">Space for a different perspective.</h2><p className="site-detail">Thoughtful spaces. Lasting impressions.<br/>Architecture shaped around the way we live.</p><div className="site-cta">Start a project <ArrowUpRight size={14}/></div></div><div className="architecture-art"><div className="arch"/><div className="arch two"/></div></div>
  <div className="site-bottom"><span>SPACES THAT MAKE ROOM FOR LIFE.</span><span>01 — RESIDENTIAL / CULTURAL</span></div>
</div>;};
