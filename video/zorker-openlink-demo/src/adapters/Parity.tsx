import {AbsoluteFill} from 'remotion';
import {ChatTimeline} from '../source-snapshot/components/film-reference-timeline.js';
import {SessionComposer} from '../source-snapshot/components/film-session-composer.js';
import {SourceTimeline,eventsAt} from './Timeline';
// Same 430x604 viewport, state, theme and font. Reference retains original hooks.
export function Parity({reference=false}:{reference?:boolean}) {
 return <AbsoluteFill className="film light" data-theme="light" style={{background:'var(--app-background)'}}>
  {reference?<ChatTimeline events={eventsAt(600)} isStreaming={false} onFlowStatusChange={undefined} onEditMessage={async()=>{}}/>:<SourceTimeline f={600}/>}
  <div className="px-2 pb-2"><SessionComposer/></div>
 </AbsoluteFill>;
}
