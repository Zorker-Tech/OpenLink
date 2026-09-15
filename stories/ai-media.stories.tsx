import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { useState } from 'react'
import { Command } from '@/components/ui/command'
import * as Audio from '@/components/ai-elements/audio-player'
import * as Voice from '@/components/ai-elements/voice-selector'
import * as Mic from '@/components/ai-elements/mic-selector'
import { SpeechInput } from '@/components/ai-elements/speech-input'
import { Transcription, TranscriptionSegment } from '@/components/ai-elements/transcription'
import { JSXPreview, JSXPreviewContent, JSXPreviewError } from '@/components/ai-elements/jsx-preview'
import { Image } from '@/components/ai-elements/image'
import { Persona } from '@/components/ai-elements/persona'
import * as Open from '@/components/ai-elements/open-in-chat'
import * as Web from '@/components/ai-elements/web-preview'
import * as Model from '@/components/ai-elements/model-selector'
import { ThinkingOrb } from '@/components/thinking/src/ThinkingOrb'

const meta = { title: 'AI Elements/Media and Preview', decorators: [(Story) => <div className="w-[min(720px,calc(100vw-48px))] p-4"><Story /></div>], parameters: { docs: { description: { component: '媒体与预览的真实组合组件。语音输入仅展示禁用状态，不采集麦克风；Persona 需访问原组件的外部 Rive 资源。' } } } } satisfies Meta
export default meta
type Story = StoryObj<typeof meta>
export const Transcript: Story = { render: () => <Transcription segments={[{ text: '检查组件', startSecond: 0, endSecond: 2 }, { text: '执行测试', startSecond: 2, endSecond: 4 }]}>{(segment, index) => <TranscriptionSegment key={index} segment={segment} index={index} />}</Transcription> }
export const AudioPlayer: Story = { render: () => <Audio.AudioPlayer><Audio.AudioPlayerElement src="data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=" /><Audio.AudioPlayerControlBar><Audio.AudioPlayerPlayButton /><Audio.AudioPlayerSeekBackwardButton /><Audio.AudioPlayerTimeDisplay /><Audio.AudioPlayerTimeRange /><Audio.AudioPlayerDurationDisplay /><Audio.AudioPlayerMuteButton /><Audio.AudioPlayerVolumeRange /></Audio.AudioPlayerControlBar></Audio.AudioPlayer> }
export const VoicePicker: Story = { render: () => <Voice.VoiceSelector><Voice.VoiceSelectorTrigger>选择语音</Voice.VoiceSelectorTrigger><Voice.VoiceSelectorContent><Command><Voice.VoiceSelectorInput placeholder="搜索语音" /><Voice.VoiceSelectorList><Voice.VoiceSelectorEmpty>没有匹配语音</Voice.VoiceSelectorEmpty><Voice.VoiceSelectorGroup heading="演示语音"><Voice.VoiceSelectorItem value="calm"><Voice.VoiceSelectorName>Calm</Voice.VoiceSelectorName><Voice.VoiceSelectorDescription>平静清晰</Voice.VoiceSelectorDescription></Voice.VoiceSelectorItem><Voice.VoiceSelectorItem value="bright"><Voice.VoiceSelectorName>Bright</Voice.VoiceSelectorName></Voice.VoiceSelectorItem></Voice.VoiceSelectorGroup></Voice.VoiceSelectorList></Command></Voice.VoiceSelectorContent></Voice.VoiceSelector> }
export const MicrophoneUnavailable: Story = { render: () => <Mic.MicSelector><Mic.MicSelectorTrigger disabled><Mic.MicSelectorValue /></Mic.MicSelectorTrigger></Mic.MicSelector> }
export const SpeechUnavailable: Story = { render: () => <SpeechInput disabled aria-label="演示模式不采集麦克风" /> }
export const JsxOutput: Story = { render: () => <JSXPreview jsx={'<section><h2>OpenLink</h2><p>实时 JSX 预览</p></section>'}><JSXPreviewContent /><JSXPreviewError /></JSXPreview> }
export const JsxStreaming: Story = { render: () => <JSXPreview isStreaming jsx={'<section><h2>正在生成'}><JSXPreviewContent /><JSXPreviewError /></JSXPreview> }
export const GeneratedImage: Story = { render: () => <Image base64="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6iAAAAABJRU5ErkJggg==" uint8Array={new Uint8Array()} mediaType="image/png" alt="演示图片输入" className="size-32 border bg-muted" /> }
export const OpenInChat: Story = { render: () => <Open.OpenIn query="演示提示词"><Open.OpenInTrigger>在其他助手打开</Open.OpenInTrigger><Open.OpenInContent><Open.OpenInChatGPT /><Open.OpenInClaude /></Open.OpenInContent></Open.OpenIn> }
export const WebPreview: Story = { render: () => <Web.WebPreview defaultUrl="about:blank"><Web.WebPreviewNavigation><Web.WebPreviewUrl aria-label="预览网址" /><Web.WebPreviewNavigationButton tooltip="刷新">↻</Web.WebPreviewNavigationButton></Web.WebPreviewNavigation><Web.WebPreviewBody title="本地演示页面" srcDoc="<!doctype html><html><body><h1>OpenLink Preview</h1><p>本地 iframe 演示，不访问外部站点。</p></body></html>" /></Web.WebPreview> }
export const ModelSearch: Story = { render: () => <Model.ModelSelector><Model.ModelSelectorTrigger>选择模型</Model.ModelSelectorTrigger><Model.ModelSelectorContent><Command><Model.ModelSelectorInput placeholder="搜索模型" /><Model.ModelSelectorList><Model.ModelSelectorEmpty>没有匹配模型</Model.ModelSelectorEmpty><Model.ModelSelectorGroup heading="演示"><Model.ModelSelectorItem value="local">本地模型</Model.ModelSelectorItem><Model.ModelSelectorItem value="reasoning">推理模型</Model.ModelSelectorItem></Model.ModelSelectorGroup></Model.ModelSelectorList></Command></Model.ModelSelectorContent></Model.ModelSelector> }
export const ThinkingStates: Story = { render: () => <div className="grid grid-cols-3 gap-6">{(['working','searching','solving','listening','connecting','weaving','composing','breathing','shaping'] as const).map(state => <div key={state} className="flex flex-col items-center gap-2"><ThinkingOrb state={state} /><span>{state}</span></div>)}</div> }
function PersonaFixture() { const [enabled, setEnabled] = useState(false); return <><button onClick={() => setEnabled(!enabled)}>{enabled ? '停止外部 Rive 预览' : '加载外部 Rive 预览'}</button>{enabled ? <div className="flex">{(['idle','listening','thinking','speaking','asleep'] as const).map(state => <Persona key={state} state={state} className="size-32" />)}</div> : <p>此组件依赖外部 Rive/WebGL 资源，手动激活后展示五种状态。</p>}</> }
export const PersonaStates: Story = { render: () => <PersonaFixture /> }
