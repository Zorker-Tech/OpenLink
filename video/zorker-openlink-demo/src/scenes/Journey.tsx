import {AbsoluteFill, Easing, Img, interpolate, staticFile, useCurrentFrame} from 'remotion';
import {ArrowLeft, ArrowRight, ArrowUpRight, Check, ChevronDown, Code2, Database, Eye, Globe, MessageCircle, RotateCw, Send} from 'lucide-react';
import type {ReactNode} from 'react';
import {useCallback, useLayoutEffect, useRef, useState} from 'react';
import {SessionComposer} from '../source-snapshot/components/film-session-composer.js';
import {SourceTimeline} from '../adapters/Timeline';
import {ThinkingOrb} from '../adapters/orb';
import {INITIAL_PROMPT, SAMPLE_CODE, stateAt} from '../fixtures';
import {SampleSite} from './SampleSite';

const ease = Easing.bezier(0.22, 1, 0.36, 1);
const soft = Easing.bezier(0.65, 0, 0.35, 1);
const clamp = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'} as const;
const eased = {...clamp, easing: ease} as const;
const softened = {...clamp, easing: soft} as const;

const Icon = ({children, selected = false}: {children: ReactNode; selected?: boolean}) => (
  <span className={`icon-button ${selected ? 'selected' : ''}`}>{children}</span>
);

function AppHeader({code = false}: {code?: boolean}) {
  return <div className="app-header">
    <Img src={staticFile('brand/zorker-logo-dark.svg')} style={{width: 25, height: 20, objectFit: 'contain'}} />
    <div style={{width: 335, display: 'flex', alignItems: 'center', gap: 8, fontSize: 13}}><span style={{color: '#888'}}>Projects</span><span style={{color: '#c0c0c0'}}>/</span><span>Forma website</span><ChevronDown size={12} /></div>
    <Icon><MessageCircle /></Icon>
    <div className="toolbar-selection"><Icon selected={!code}><Eye /></Icon><Icon><Send /></Icon><Icon selected={code}><Code2 /></Icon><Icon><Database /></Icon></div>
    <div style={{display: 'flex', alignItems: 'center', flex: 1, height: 27, border: '1px solid var(--app-control-border)', borderRadius: 6, fontSize: 12, color: '#858585', gap: 8, padding: '0 8px'}}><ArrowLeft size={13} /><ArrowRight size={13} /><span style={{flex: 1}}>localhost:3000</span><RotateCw size={13} /><ArrowUpRight size={13} /></div>
    <span style={{fontSize: 12, color: '#777'}}>Latest</span><ChevronDown size={13} />
  </div>;
}

type FrontMap = Map<number, {x: number; y: number}>;
type WorkspaceProps = {f: number; text?: string; showTimeline?: boolean; onFronts?: (fronts: FrontMap) => void};

type ProbeGeometry = {x: number; y: number; width: number; lineHeight: number; style: React.CSSProperties};

const originInWindow = (element: HTMLElement): {x: number; y: number} => {
  let x = 0;
  let y = 0;
  let node: HTMLElement | null = element;
  while (node && !node.classList.contains('app-window')) {
    x += node.offsetLeft;
    y += node.offsetTop;
    node = node.offsetParent as HTMLElement | null;
  }
  return {x, y};
};

function ComposerFrontProbe({typed, onFronts}: {typed: string; onFronts?: (fronts: FrontMap) => void}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const [geometry, setGeometry] = useState<ProbeGeometry | null>(null);
  const emitted = useRef('');
  useLayoutEffect(() => {
    const host = hostRef.current;
    const textarea = host?.closest('.app-window')?.querySelector('textarea') as HTMLTextAreaElement | null;
    if (!host || !textarea) return;
    const style = getComputedStyle(textarea);
    const paddingLeft = Number.parseFloat(style.paddingLeft) || 0;
    const paddingTop = Number.parseFloat(style.paddingTop) || 0;
    const textOrigin = originInWindow(textarea);
    const hostOrigin = originInWindow(host);
    const next: ProbeGeometry = {
      x: textOrigin.x + paddingLeft - hostOrigin.x,
      y: textOrigin.y + paddingTop - hostOrigin.y,
      width: Math.max(1, textarea.clientWidth - paddingLeft - (Number.parseFloat(style.paddingRight) || 0)),
      lineHeight: Number.parseFloat(style.lineHeight) || 20,
      style: {fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight, lineHeight: style.lineHeight, letterSpacing: style.letterSpacing},
    };
    setGeometry((previous) => !previous || previous.x !== next.x || previous.y !== next.y || previous.width !== next.width || previous.lineHeight !== next.lineHeight ? next : previous);
  });
  useLayoutEffect(() => {
    const mirror = mirrorRef.current;
    if (!mirror || !geometry || !onFronts) return;
    const base = originInWindow(mirror);
    const fronts: FrontMap = new Map();
    let lastX = base.x;
    let lastY = base.y + geometry.lineHeight / 2;
    for (const child of Array.from(mirror.children)) {
      const element = child as HTMLElement;
      const index = Number(element.dataset.front);
      const point = {x: base.x + element.offsetLeft, y: base.y + element.offsetTop + geometry.lineHeight / 2};
      fronts.set(index, point);
      lastX = point.x + element.offsetWidth;
      lastY = point.y;
    }
    fronts.set(typed.length, {x: lastX, y: lastY});
    const key = `${typed.length}:${Array.from(fronts, ([index, point]) => `${index},${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(';')}`;
    if (key !== emitted.current) {
      emitted.current = key;
      onFronts(fronts);
    }
  }, [geometry, typed, onFronts]);
  return <div ref={hostRef} style={{position: 'absolute', left: 0, top: 0, width: 0, height: 0, pointerEvents: 'none'}}>
    {geometry && <div ref={mirrorRef} style={{position: 'absolute', left: geometry.x, top: geometry.y, width: geometry.width, visibility: 'hidden', whiteSpace: 'pre-wrap', wordBreak: 'normal', ...geometry.style}}>
      {typed.split('').map((character, index) => <span key={index} data-front={index}>{character}</span>)}
    </div>}
  </div>;
}

export function Workspace({f, text, showTimeline, onFronts}: WorkspaceProps) {
  const s = stateAt(f);
  const typed = text ?? INITIAL_PROMPT.slice(0, Math.floor(interpolate(f, [35, 190], [0, INITIAL_PROMPT.length], clamp)));
  const timelineVisible = showTimeline ?? s.submitted;
  return <div className="app-window light" data-theme="light" style={{position: 'absolute', width: 1280, height: 720}}>
    <AppHeader code={s.code} />
    <div style={{display: 'flex', height: 674}}>
      <aside className="flex size-full min-w-0 flex-col border-r border-[var(--app-border)] bg-[var(--app-background)]" style={{width: 430, flexShrink: 0, position: 'relative'}}>
        {timelineVisible ? <SourceTimeline f={f} /> : <div style={{flex: 1}} />}
        <div className="px-2 pb-2" style={{position: 'relative'}}>
          <SessionComposer text={s.submitted ? '' : typed} expanded={!s.submitted} busy={s.working || s.resending || (s.revised && !s.finished)} />
          {!s.submitted && <ComposerFrontProbe typed={typed} onFronts={onFronts} />}
        </div>
      </aside>
      <main style={{flex: 1, minWidth: 0, position: 'relative', background: '#f8f8f7'}}>
        {s.preview ? s.code ? <div style={{height: '100%', background: '#fafafa'}}><div style={{height: 36, display: 'flex', alignItems: 'center', gap: 8, borderBottom: '1px solid #e5e5e5', padding: '0 20px', fontSize: 12}}><Code2 size={14} />app/page.tsx<span style={{marginLeft: 'auto', color: '#8b8b8b'}}>TypeScript React</span></div><pre style={{padding: '20px 6px', fontSize: 12, lineHeight: '22px', color: '#373b43', fontFamily: 'monospace'}}>{SAMPLE_CODE.map((line, i) => <span key={i} className="code-line"><span className="code-num">{i + 1}</span>{line}</span>)}</pre></div> : <SampleSite blue={s.finished} /> : <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 18, color: '#aaa'}}><Globe size={35} strokeWidth={1} /><span style={{fontSize: 14}}>Your preview will appear here</span></div>}
        {s.finished && <div style={{position: 'absolute', right: 16, bottom: 15, background: '#fff', border: '1px solid #dedede', borderRadius: 20, display: 'flex', alignItems: 'center', gap: 6, padding: '7px 12px', fontSize: 10, color: '#555'}}><Check size={12} />Illustrative result</div>}
      </main>
    </div>
  </div>;
}

const TYPE_KEYS = [42, 86, 142, 202, 270, 338, 390];
const COUNT_KEYS = [0, 15, 40, 63, 91, 119, INITIAL_PROMPT.length];
const LINE_STARTS = [0, 60, 119];
const LINE_ENDS = [60, 119, INITIAL_PROMPT.length];
const typedCountAt = (frame: number) => interpolate(frame, TYPE_KEYS, COUNT_KEYS, softened);

const frontForCount = (count: number) => {
  const safeCount = Math.max(0, Math.min(INITIAL_PROMPT.length, count));
  const line = safeCount >= LINE_STARTS[2] ? 2 : safeCount >= LINE_STARTS[1] ? 1 : 0;
  const progress = (safeCount - LINE_STARTS[line]) / Math.max(1, LINE_ENDS[line] - LINE_STARTS[line]);
  return {x: 44 + progress * 340, y: 658 + line * 23};
};

const trackedFrontAt = (frame: number, sample: (count: number) => {x: number; y: number}) => {
  let x = 0;
  let y = 0;
  let total = 0;
  for (let index = 0; index < 28; index++) {
    const age = index * 0.72;
    const weight = Math.exp(-age / 4.8);
    const point = sample(typedCountAt(frame - age));
    x += point.x * weight;
    y += point.y * weight;
    total += weight;
  }
  return {x: x / total, y: y / total};
};

const alpha = (frame: number, enter: [number, number], exit: [number, number]) => interpolate(frame, [enter[0], enter[1], exit[0], exit[1]], [0, 1, 1, 0], eased);

function InputTracking({f}: {f: number}) {
  const [fronts, setFronts] = useState<FrontMap | null>(null);
  const handleFronts = useCallback((map: FrontMap) => setFronts(map), []);
  const count = Math.floor(typedCountAt(f));
  const sample = useCallback((raw: number) => {
    const index = Math.max(0, Math.min(INITIAL_PROMPT.length, Math.round(raw)));
    return fronts?.get(index) ?? frontForCount(index);
  }, [fronts]);
  const front = trackedFrontAt(f, sample);
  const caret = sample(count);
  const origin = sample(0);
  const pullBack = interpolate(f, [398, 535], [0, 1], softened);
  const cameraScale = Math.exp(interpolate(f, [0, 56, 360, 535], [Math.log(2.55), Math.log(4.05), Math.log(4.3), Math.log(1.5)], softened));
  const follow = interpolate(f, [20, 70], [0, 1], eased) * (1 - pullBack);
  const focusX = interpolate(pullBack, [0, 1], [interpolate(follow, [0, 1], [origin.x + 150, front.x]), 640]);
  const focusY = interpolate(pullBack, [0, 1], [interpolate(follow, [0, 1], [origin.y, front.y]), 360]);
  return <AbsoluteFill style={{background: '#fff', overflow: 'hidden', opacity: interpolate(f, [500, 570], [1, 0], eased)}}>
    <div style={{position: 'absolute', left: 960 - cameraScale * focusX, top: 540 - cameraScale * focusY, scale: cameraScale, transformOrigin: '0 0'}}>
      <Workspace f={0} text={INITIAL_PROMPT.slice(0, count)} showTimeline={false} onFronts={handleFronts} />
      {count > 0 && count < INITIAL_PROMPT.length && <div style={{position: 'absolute', left: caret.x + 1.5, top: caret.y - 9, width: 1.4, height: 17, borderRadius: 2, background: '#7168f4', opacity: 0.7 + 0.3 * Math.sin(f / 5)}} />}
    </div>
    <div style={{position: 'absolute', left: 0, right: 0, bottom: 0, height: 3, background: '#7168f4', scale: `${interpolate(f, [42, 390], [0, 1], eased)} 1`, transformOrigin: '0 50%', opacity: interpolate(f, [365, 455], [0.9, 0], eased)}} />
  </AbsoluteFill>;
}

function NarrativeType({f}: {f: number}) {
  const first = alpha(f, [430, 500], [825, 900]);
  const second = alpha(f, [895, 965], [1280, 1360]);
  const rule = interpolate(f, [470, 790], [0, 1], eased);
  return <AbsoluteFill style={{overflow: 'hidden'}}>
    <AbsoluteFill style={{background: '#f4f3ee', opacity: interpolate(f, [410, 485], [0, 1], eased)}} />
    <div style={{position: 'absolute', left: 112, top: 104, opacity: first, translate: `0 ${interpolate(first, [0, 1], [55, 0])}px`}}>
      <div style={{fontSize: 228, lineHeight: 0.82, letterSpacing: -14, fontWeight: 520}}>IDEAS</div>
      <div style={{fontSize: 228, lineHeight: 0.82, letterSpacing: -14, fontWeight: 520, marginLeft: 310}}>SHOULD</div>
      <div style={{fontSize: 228, lineHeight: 0.82, letterSpacing: -14, fontWeight: 520, color: '#7168f4', marginLeft: 80}}>MOVE.</div>
    </div>
    <div style={{position: 'absolute', left: 120, right: 120, top: 835, height: 2, background: '#171717', scale: `${rule} 1`, transformOrigin: '0 50%', opacity: first}} />
    <div style={{position: 'absolute', left: 126, top: 872, fontSize: 18, letterSpacing: 3.2, textTransform: 'uppercase', color: '#777a74', opacity: first}}>The moment they are written.</div>
    <div style={{position: 'absolute', left: 114, top: 145, opacity: second}}>
      <div style={{fontSize: 60, letterSpacing: -3, marginBottom: 32, color: '#777a74'}}>From intent</div>
      <div style={{fontSize: 244, lineHeight: 0.82, letterSpacing: -15, fontWeight: 540}}>TO</div>
      <div style={{fontSize: 244, lineHeight: 0.82, letterSpacing: -15, fontWeight: 540}}>SYSTEM.</div>
    </div>
  </AbsoluteFill>;
}

function AbstractSystem({f}: {f: number}) {
  const visibility = alpha(f, [690, 770], [1390, 1490]);
  const timelineProgress = interpolate(f, [720, 1270], [0, 1], softened);
  const timelineScale = interpolate(timelineProgress, [0, 0.58, 1], [1.72, 1.3, 1.08]);
  const orbProgress = interpolate(f, [760, 1210], [0, 1], softened);
  return <AbsoluteFill style={{overflow: 'hidden', opacity: visibility, pointerEvents: 'none'}}>
    <div className="light" data-theme="light" style={{position: 'absolute', left: interpolate(timelineProgress, [0, 1], [1310, 910]), top: interpolate(timelineProgress, [0, 1], [95, 250]), width: 430, height: 604, background: 'rgba(255,255,255,.94)', overflow: 'hidden', scale: timelineScale, transformOrigin: '50% 25%', clipPath: `inset(${interpolate(timelineProgress, [0, 0.35], [46, 0], eased)}% 0 0 0)`, boxShadow: '0 30px 90px rgba(29,31,28,.08)'}}>
      <SourceTimeline f={interpolate(f, [720, 1260], [300, 590], clamp)} />
    </div>
    <div style={{position: 'absolute', left: interpolate(orbProgress, [0, 1], [1040, 928]), top: interpolate(orbProgress, [0, 1], [725, 700]), scale: interpolate(orbProgress, [0, 0.55, 1], [0.9, 2, 1.25]), filter: 'drop-shadow(0 24px 50px rgba(113,104,244,.22))'}}><ThinkingOrb state="working" size={64} /></div>
    {[0, 1, 2].map((index) => <div key={index} style={{position: 'absolute', left: 104 + index * 188, top: 838 - index * 46, width: interpolate(f, [820 + index * 28, 1120 + index * 28], [0, 420 - index * 54], eased), height: 2, background: index === 1 ? '#7168f4' : '#1a1b19', opacity: interpolate(f, [790 + index * 35, 850 + index * 35], [0, 0.78], eased)}} />)}
  </AbsoluteFill>;
}

function ProductResolve({f}: {f: number}) {
  const reveal = interpolate(f, [1325, 1435], [0, 1], softened);
  const scale = Math.exp(interpolate(reveal, [0, 1], [Math.log(2.4), Math.log(1.5)]));
  const focusX = interpolate(reveal, [0, 1], [238, 640]);
  const focusY = interpolate(reveal, [0, 1], [300, 360]);
  return <AbsoluteFill style={{background: '#fff', overflow: 'hidden', opacity: reveal}}>
    <div style={{position: 'absolute', left: 960 - scale * focusX, top: 540 - scale * focusY, scale, transformOrigin: '0 0'}}><Workspace f={1320} /></div>
    <div style={{position: 'absolute', right: 74, bottom: 62, fontSize: 15, letterSpacing: 2.4, textTransform: 'uppercase', color: '#777', opacity: interpolate(f, [1515, 1585], [0, 1], eased)}}>Zorker OpenLink</div>
  </AbsoluteFill>;
}

export const Journey = () => {
  const f = useCurrentFrame();
  return <AbsoluteFill style={{background: '#f4f3ee', overflow: 'hidden'}}><InputTracking f={f} /><NarrativeType f={f} /><AbstractSystem f={f} /><ProductResolve f={f} /></AbsoluteFill>;
};
