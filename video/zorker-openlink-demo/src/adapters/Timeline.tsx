import {ChatTimeline} from '../source-snapshot/components/chat-timeline.js';
import {FilmState} from './state';
import {INITIAL_PROMPT,REVISED_PROMPT,USER_MESSAGE_ID,stateAt} from '../fixtures';

// Synthetic protocol events, never sent to a provider. Source reducer determines UI.
export function eventsAt(f:number) {
 const s=stateAt(f),events:Record<string,unknown>[]=[];
 const push=(at:number,type:string,data:Record<string,unknown>={})=>{
  if(f>=at)events.push({version:1,sessionId:'film-demo',source:'codex',sequence:events.length+1,timestamp:new Date(1788755100000+at*1000/30).toISOString(),type,...data});
 };
 const start=s.revised?1220:245;
 push(start,'message.user',{messageId:USER_MESSAGE_ID,text:s.revised?REVISED_PROMPT:INITIAL_PROMPT});
 push(start,'session.started');
 if(s.revised) {
  push(1230,'file.editing.started',{editId:'revise',taskId:'update',path:'app/globals.css',operation:'edit'});
  push(1300,'file.editing.completed',{editId:'revise',taskId:'update',path:'app/globals.css',operation:'edit'});
 } else {
  push(275,'tool.started',{toolId:'read',taskId:'read',name:'read_file',input:{path:'package.json'}});
  push(365,'tool.completed',{toolId:'read',taskId:'read',output:'Project dependencies read.'});
  push(390,'file.editing.started',{editId:'page',taskId:'page',path:'app/page.tsx',operation:'write'});
  push(465,'file.editing.completed',{editId:'page',taskId:'page',path:'app/page.tsx',operation:'write'});
  push(480,'command.started',{commandId:'build',taskId:'build',command:'npm run build'});
  push(570,'command.completed',{commandId:'build',taskId:'build',exitCode:0,output:'Demo build completed.'});
 }
 const end=s.revised?1320:600;
 push(end,'message.completed',{messageId:'result',text:s.revised?'Updated the palette to electric blue. The layout and inquiry link are unchanged.':'The landing page is ready to review. Explore the preview or inspect the files below.'});
 push(end,'file.changed',{changeId:'changes',label:s.revised?'Updated the visual theme':'Created the landing page',snapshot:true,files:[{path:s.revised?'app/globals.css':'app/page.tsx',additions:s.revised?8:68,deletions:s.revised?8:0,patch:s.revised?'@@ -1 +1 @@\n- --accent: #292d25;\n+ --accent: #254af3;':'@@ -0,0 +1,68 @@\n+ export default function Home() {\n+   return <main className="forma-page">\n+     <Navigation brand="forma" />\n+     <Hero />\n+   </main>;\n+ }'}]});
 push(end,'session.completed');
 return events;
}
export function SourceTimeline({f}:{f:number}) {
 const s=stateAt(f);
 return <FilmState.Provider value={{editing:s.editing||s.resending,pending:s.resending,draft:f<1090?INITIAL_PROMPT:REVISED_PROMPT,changesOpen:s.code}}>
  <ChatTimeline events={eventsAt(f)} isStreaming={s.working||s.revised&&!s.finished} onFlowStatusChange={undefined} onEditMessage={undefined}/>
 </FilmState.Provider>;
}
