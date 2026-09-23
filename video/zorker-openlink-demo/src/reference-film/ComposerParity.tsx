import {useEffect,useState} from 'react';
import {continueRender,delayRender} from 'remotion';
import {CurrentHomeComposer} from './current-ui/components/film-home-composer.js';
import {CurrentSessionComposer} from './current-ui/components/film-chat-composer.js';
import {NativePrompt,PROMPT,REVISION} from './Native';
import {FilmCurrentUi} from './FilmLocale';

export function ComposerParity({reference=true,kind='home'}:{reference?:boolean;kind?:'home'|'chat'}){
 const [handle]=useState(()=>delayRender('Native composer parity font'));
 useEffect(()=>{document.fonts.load('400 14px OpenLinkGeist').then(()=>continueRender(handle));},[handle]);
 const text=kind==='home'?PROMPT:REVISION;
 return <div className="film" style={{position:'absolute',inset:0,background:'#ffffff'}}><div data-openlink-theme="light" className="light" style={{position:'absolute',left:150,top:95,width:700,background:'transparent'}}>
  <FilmCurrentUi>{reference?(kind==='home'?<CurrentHomeComposer text={text}/>:<CurrentSessionComposer text={text}/>):<NativePrompt text={text} fullText={text} kind={kind} caret={false}/>}</FilmCurrentUi>
 </div></div>;
}
