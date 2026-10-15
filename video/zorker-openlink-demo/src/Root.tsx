import "./film.css";
import {Composition} from 'remotion';
import { Demo } from "./Composition";
import {Parity} from './adapters/Parity';
import {ReferenceFilm} from './reference-film/Film';
import {ComposerParity} from './reference-film/ComposerParity';
import storyboard from './reference-film/storyboard-v10.json';
import {LaunchFilm} from './launch-film/LaunchFilm';
import launchStoryboard from './launch-film/storyboard.json';
import {LaunchFilmV2} from './launch-film/LaunchFilmV2';
import launchStoryboardV2 from './launch-film/storyboard-v2.json';

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition id="OpenLinkReferenceFilm" component={ReferenceFilm} durationInFrames={storyboard.runtimeFrames} fps={60} width={3840} height={2160}/>
      <Composition id="OpenLink120Master" component={ReferenceFilm} durationInFrames={storyboard.runtimeFrames*2} fps={120} width={3840} height={2160}/>
      <Composition id="OpenLinkLaunchFilm120" component={LaunchFilm} durationInFrames={launchStoryboard.runtimeSeconds*120} fps={120} width={3840} height={2160}/>
      <Composition id="OpenLinkLaunchFilm60" component={LaunchFilm} durationInFrames={launchStoryboard.runtimeSeconds*60} fps={60} width={3840} height={2160}/>
      <Composition id="OpenLinkLaunchFilmV2-120" component={LaunchFilmV2} durationInFrames={launchStoryboardV2.runtimeSeconds*120} fps={120} width={3840} height={2160}/>
      <Composition id="OpenLinkLaunchFilmV2-60" component={LaunchFilmV2} durationInFrames={launchStoryboardV2.runtimeSeconds*60} fps={60} width={3840} height={2160}/>
      <Composition id="CurrentHomeSource" component={ComposerParity} defaultProps={{reference:true,kind:'home'}} durationInFrames={1} fps={60} width={1000} height={400}/>
      <Composition id="CurrentHomeFilm" component={ComposerParity} defaultProps={{reference:false,kind:'home'}} durationInFrames={1} fps={60} width={1000} height={400}/>
      <Composition id="CurrentChatSource" component={ComposerParity} defaultProps={{reference:true,kind:'chat'}} durationInFrames={1} fps={60} width={1000} height={400}/>
      <Composition id="CurrentChatFilm" component={ComposerParity} defaultProps={{reference:false,kind:'chat'}} durationInFrames={1} fps={60} width={1000} height={400}/>
      <Composition id="ZorkerOpenLink" component={Demo} durationInFrames={1800} fps={30} width={1920} height={1080} />
      <Composition id="SourceReference" component={Parity} defaultProps={{reference:true}} durationInFrames={1} fps={30} width={430} height={604}/>
      <Composition id="FilmParity" component={Parity} defaultProps={{reference:false}} durationInFrames={1} fps={30} width={430} height={604}/>
    </>
  );
};
