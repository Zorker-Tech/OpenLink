'use client'

import type { AiProviderDefinition } from '@/lib/ai-providers'
import AlibabaCloudMono from '@lobehub/icons/es/AlibabaCloud/components/Mono'
import AlibabaCloudText from '@lobehub/icons/es/AlibabaCloud/components/Text'
import AntGroupMono from '@lobehub/icons/es/AntGroup/components/Mono'
import AntGroupText from '@lobehub/icons/es/AntGroup/components/Text'
import AnthropicMono from '@lobehub/icons/es/Anthropic/components/Mono'
import AnthropicText from '@lobehub/icons/es/Anthropic/components/Text'
import AwsColor from '@lobehub/icons/es/Aws/components/Color'
import AwsMono from '@lobehub/icons/es/Aws/components/Mono'
import AwsText from '@lobehub/icons/es/Aws/components/Text'
import AzureMono from '@lobehub/icons/es/Azure/components/Mono'
import AzureText from '@lobehub/icons/es/Azure/components/Text'
import BasetenMono from '@lobehub/icons/es/Baseten/components/Mono'
import BasetenText from '@lobehub/icons/es/Baseten/components/Text'
import BedrockMono from '@lobehub/icons/es/Bedrock/components/Mono'
import BedrockText from '@lobehub/icons/es/Bedrock/components/Text'
import CerebrasMono from '@lobehub/icons/es/Cerebras/components/Mono'
import CerebrasText from '@lobehub/icons/es/Cerebras/components/Text'
import ClaudeColor from '@lobehub/icons/es/Claude/components/Color'
import ClaudeText from '@lobehub/icons/es/Claude/components/Text'
import CloudflareMono from '@lobehub/icons/es/Cloudflare/components/Mono'
import CloudflareText from '@lobehub/icons/es/Cloudflare/components/Text'
import DeepSeekMono from '@lobehub/icons/es/DeepSeek/components/Mono'
import DeepSeekText from '@lobehub/icons/es/DeepSeek/components/Text'
import FireworksMono from '@lobehub/icons/es/Fireworks/components/Mono'
import FireworksText from '@lobehub/icons/es/Fireworks/components/Text'
import GeminiMono from '@lobehub/icons/es/Gemini/components/Mono'
import GeminiText from '@lobehub/icons/es/Gemini/components/Text'
import GithubCopilotMono from '@lobehub/icons/es/GithubCopilot/components/Mono'
import GithubCopilotText from '@lobehub/icons/es/GithubCopilot/components/Text'
import GoogleBrandColor from '@lobehub/icons/es/Google/components/BrandColor'
import GoogleMono from '@lobehub/icons/es/Google/components/Mono'
import GroqMono from '@lobehub/icons/es/Groq/components/Mono'
import GroqText from '@lobehub/icons/es/Groq/components/Text'
import HuggingFaceMono from '@lobehub/icons/es/HuggingFace/components/Mono'
import HuggingFaceText from '@lobehub/icons/es/HuggingFace/components/Text'
import MinimaxMono from '@lobehub/icons/es/Minimax/components/Mono'
import MinimaxText from '@lobehub/icons/es/Minimax/components/Text'
import MistralMono from '@lobehub/icons/es/Mistral/components/Mono'
import MistralText from '@lobehub/icons/es/Mistral/components/Text'
import MoonshotMono from '@lobehub/icons/es/Moonshot/components/Mono'
import MoonshotText from '@lobehub/icons/es/Moonshot/components/Text'
import NvidiaMono from '@lobehub/icons/es/Nvidia/components/Mono'
import NvidiaText from '@lobehub/icons/es/Nvidia/components/Text'
import OpenAIMono from '@lobehub/icons/es/OpenAI/components/Mono'
import OpenAIText from '@lobehub/icons/es/OpenAI/components/Text'
import OpenCodeMono from '@lobehub/icons/es/OpenCode/components/Mono'
import OpenCodeText from '@lobehub/icons/es/OpenCode/components/Text'
import OpenRouterMono from '@lobehub/icons/es/OpenRouter/components/Mono'
import OpenRouterText from '@lobehub/icons/es/OpenRouter/components/Text'
import QwenMono from '@lobehub/icons/es/Qwen/components/Mono'
import QwenText from '@lobehub/icons/es/Qwen/components/Text'
import TogetherMono from '@lobehub/icons/es/Together/components/Mono'
import TogetherText from '@lobehub/icons/es/Together/components/Text'
import VercelMono from '@lobehub/icons/es/Vercel/components/Mono'
import VercelText from '@lobehub/icons/es/Vercel/components/Text'
import VertexAIMono from '@lobehub/icons/es/VertexAI/components/Mono'
import VertexAIText from '@lobehub/icons/es/VertexAI/components/Text'
import WorkersAIMono from '@lobehub/icons/es/WorkersAI/components/Mono'
import WorkersAIText from '@lobehub/icons/es/WorkersAI/components/Text'
import XAIMono from '@lobehub/icons/es/XAI/components/Mono'
import XAIText from '@lobehub/icons/es/XAI/components/Text'
import XiaomiMiMoMono from '@lobehub/icons/es/XiaomiMiMo/components/Mono'
import XiaomiMiMoText from '@lobehub/icons/es/XiaomiMiMo/components/Text'
import ZhipuMono from '@lobehub/icons/es/Zhipu/components/Mono'
import ZhipuText from '@lobehub/icons/es/Zhipu/components/Text'
import type { ComponentType, CSSProperties, ReactNode } from 'react'

export function HyditeMono({ size = 24, style, className }: { size?: number | string; style?: CSSProperties; className?: string }) {
  const numericSize = typeof size === 'number' ? size : 24
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center ${className ?? ''}`}
      style={{
        height: size,
        width: size,
        ...style,
      }}
    >
      <img
        alt="Hydite"
        className="size-full object-contain"
        height={numericSize}
        src="/openlink/providers/hydite.svg"
        width={numericSize}
      />
    </span>
  )
}

export function VtslxText({ size = 24, style, className }: { size?: number | string; style?: CSSProperties; className?: string }) {
  const numericSize = typeof size === 'number' ? size : 24
  // Wordmark artwork is ~8:1 (w:h). Render at the scaled text height and let
  // the aspect ratio flow naturally so the mark is no longer dwarfed by the
  // surrounding SVG padding.
  const textHeight = Math.round(numericSize * 0.72)
  return (
    <span
      className={`inline-flex shrink-0 items-center ${className ?? ''}`}
      style={{
        height: textHeight,
        ...style,
      }}
    >
      <img
        alt="Vtslx AO"
        className="h-full w-auto object-contain"
        height={textHeight}
        src="/openlink/providers/vtslxao.svg"
      />
    </span>
  )
}

type ProviderIdentity = Pick<AiProviderDefinition, 'id' | 'name' | 'logo'>
type SvgIcon = ComponentType<{ size?: number | string; style?: CSSProperties }>
type IconFamily = { Mono: SvgIcon; Text?: SvgIcon }

const iconFamilies: Record<string, IconFamily> = {
  antgroup: { Mono: AntGroupMono, Text: AntGroupText },
  anthropic: { Mono: AnthropicMono, Text: AnthropicText },
  aws: { Mono: AwsMono, Text: AwsText },
  azure: { Mono: AzureMono, Text: AzureText },
  baseten: { Mono: BasetenMono, Text: BasetenText },
  cerebras: { Mono: CerebrasMono, Text: CerebrasText },
  cloudflare: { Mono: CloudflareMono, Text: CloudflareText },
  deepseek: { Mono: DeepSeekMono, Text: DeepSeekText },
  fireworks: { Mono: FireworksMono, Text: FireworksText },
  gemini: { Mono: GeminiMono, Text: GeminiText },
  github: { Mono: GithubCopilotMono, Text: GithubCopilotText },
  groq: { Mono: GroqMono, Text: GroqText },
  huggingface: { Mono: HuggingFaceMono, Text: HuggingFaceText },
  kimi: { Mono: MoonshotMono, Text: MoonshotText },
  minimax: { Mono: MinimaxMono, Text: MinimaxText },
  mistral: { Mono: MistralMono, Text: MistralText },
  moonshot: { Mono: MoonshotMono, Text: MoonshotText },
  nvidia: { Mono: NvidiaMono, Text: NvidiaText },
  openai: { Mono: OpenAIMono, Text: OpenAIText },
  opencode: { Mono: OpenCodeMono, Text: OpenCodeText },
  openrouter: { Mono: OpenRouterMono, Text: OpenRouterText },
  qwen: { Mono: QwenMono, Text: QwenText },
  together: { Mono: TogetherMono, Text: TogetherText },
  hydite: { Mono: HyditeMono, Text: VtslxText },
  vercel: { Mono: VercelMono, Text: VercelText },
  vertexai: { Mono: VertexAIMono, Text: VertexAIText },
  xai: { Mono: XAIMono, Text: XAIText },
  xiaomi: { Mono: XiaomiMiMoMono, Text: XiaomiMiMoText },
  zhipu: { Mono: ZhipuMono, Text: ZhipuText },
}

function getIconFamily(provider: ProviderIdentity) {
  return iconFamilies[provider.logo]
}

export function ProviderLogo({ provider, size = 28 }: { provider: ProviderIdentity; size?: number }) {
  const Family = getIconFamily(provider)
  if (!Family) return <FallbackAvatar provider={provider} size={size} />

  return (
    <span
      aria-label={`${provider.name} logo`}
      className="flex shrink-0 items-center justify-center overflow-hidden rounded-[6px] bg-[var(--app-active)] text-[var(--app-foreground)] shadow-[inset_0_0_0_1px_var(--app-border)]"
      style={{ height: size, width: size }}
    >
      <Family.Mono size={size * 0.68} />
    </span>
  )
}

/** OpenLink fork of LobeHub's ProviderCombine without its Ant Design runtime. */
export function ProviderBrand({ provider, size = 24 }: { provider: ProviderIdentity; size?: number }) {
  const special = getCombinedBrand(provider, size)
  if (special) return <span className="flex h-9 min-w-0 items-center overflow-hidden">{special}</span>

  const family = getIconFamily(provider)
  return (
    <span className="flex h-9 min-w-0 items-center overflow-hidden text-[var(--app-foreground)]">
      {family ? <BrandUnit family={family} size={size} /> : <span className="truncate text-[15px] font-semibold tracking-[-0.2px]">{provider.name}</span>}
    </span>
  )
}

function BrandUnit({ family, icon, size }: { family: IconFamily; icon?: ReactNode; size: number }) {
  return (
    <span className="flex min-w-0 items-center gap-[5px]">
      {icon ?? <family.Mono size={size} />}
      {family.Text && <family.Text size={size * 0.72} />}
    </span>
  )
}

function BrandDivider() {
  return <span aria-hidden="true" className="mx-[7px] h-[15px] w-px shrink-0 bg-[var(--app-border)]" />
}

function getCombinedBrand(provider: ProviderIdentity, size: number): ReactNode {
  switch (provider.id) {
    case 'amazon-bedrock':
      return <><BrandUnit family={{ Mono: AwsMono, Text: AwsText }} icon={<AwsColor size={size * 1.05} />} size={size} /><BrandDivider /><BrandUnit family={{ Mono: BedrockMono, Text: BedrockText }} size={size} /></>
    case 'anthropic':
      return <><AnthropicText size={size * 0.76} /><BrandDivider /><BrandUnit family={{ Mono: ClaudeColor, Text: ClaudeText }} size={size} /></>
    case 'azure-openai-responses':
      return <><BrandUnit family={{ Mono: AzureMono, Text: AzureText }} size={size * 0.92} /><BrandDivider /><BrandUnit family={{ Mono: OpenAIMono, Text: OpenAIText }} size={size} /></>
    case 'google':
      return <><GoogleBrandColor size={size * 0.92} /><BrandDivider /><BrandUnit family={{ Mono: GeminiMono, Text: GeminiText }} size={size} /></>
    case 'google-vertex':
      return <><GoogleBrandColor size={size * 0.92} /><BrandDivider /><BrandUnit family={{ Mono: VertexAIMono, Text: VertexAIText }} size={size} /></>
    case 'cloudflare-workers-ai':
      return <><BrandUnit family={{ Mono: CloudflareMono, Text: CloudflareText }} size={size} /><BrandDivider /><BrandUnit family={{ Mono: WorkersAIMono, Text: WorkersAIText }} size={size} /></>
    case 'qwen-token-plan':
    case 'qwen-token-plan-cn':
      return <><BrandUnit family={{ Mono: AlibabaCloudMono, Text: AlibabaCloudText }} size={size} /><BrandDivider /><BrandUnit family={{ Mono: QwenMono, Text: QwenText }} size={size * 0.9} /></>
    case 'hydite-vtslx-ao':
      return <><BrandUnit family={{ Mono: HyditeMono, Text: VtslxText }} size={size} /></>
    default:
      return null
  }
}

function FallbackAvatar({ provider, size }: { provider: ProviderIdentity; size: number }) {
  return <span className="flex shrink-0 items-center justify-center rounded-[6px] bg-[var(--app-active)] text-[11px] font-semibold text-[var(--app-muted)]" style={{ height: size, width: size }}>{provider.name.slice(0, 1)}</span>
}
