import {AbsoluteFill, Sequence} from 'remotion';
import {BrandReveal} from './scenes/BrandReveal';
import {Journey} from './scenes/Journey';
import {Ending} from './scenes/Ending';
export const Demo = () => <AbsoluteFill className="film">
  <Sequence from={0} durationInFrames={90} name="Brand to product"><BrandReveal /></Sequence>
  <Sequence from={90} durationInFrames={1620} name="Native workspace — continuous camera"><Journey /></Sequence>
  <Sequence from={1710} durationInFrames={90} name="Zorker OpenLink"><Ending /></Sequence>
</AbsoluteFill>;
