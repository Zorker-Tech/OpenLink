export type ProviderAuthMode = 'api-key' | 'oauth' | 'ambient'

export interface AiProviderDefinition {
  id: string
  name: string
  description: string
  category: 'global' | 'china' | 'gateway' | 'cloud' | 'subscription'
  authMode: ProviderAuthMode
  baseUrl: string | null
  logo: string
  apiKeyLabel: string
}

const provider = (
  id: string,
  name: string,
  description: string,
  baseUrl: string | null,
  options: Partial<Pick<AiProviderDefinition, 'category' | 'authMode' | 'logo' | 'apiKeyLabel'>> = {},
): AiProviderDefinition => ({
  id,
  name,
  description,
  baseUrl,
  category: options.category ?? 'global',
  authMode: options.authMode ?? 'api-key',
  logo: options.logo ?? id,
  apiKeyLabel: options.apiKeyLabel ?? `${name} API Key`,
})

/** Presentation metadata for every provider returned by Pi builtinProviders(). */
export const AI_PROVIDERS = [
  provider('amazon-bedrock', 'Amazon Bedrock', '通过 AWS Bedrock 使用 Claude、Llama 与其他企业模型。', null, { category: 'cloud', authMode: 'ambient', logo: 'aws' }),
  provider('ant-ling', 'Ant Ling', '蚂蚁百灵通用人工智能模型与编码能力。', 'https://api.ant-ling.com/v1', { category: 'china', logo: 'antgroup' }),
  provider('anthropic', 'Anthropic', 'Claude 系列模型，适合复杂推理、编码与长上下文任务。', 'https://api.anthropic.com', { logo: 'anthropic' }),
  provider('azure-openai-responses', 'Azure OpenAI', '通过 Azure 部署访问 OpenAI Responses API。', null, { category: 'cloud', logo: 'azure' }),
  provider('baseten', 'Baseten', '面向生产环境的高性能模型推理平台。', 'https://inference.baseten.co/v1', { category: 'cloud' }),
  provider('cerebras', 'Cerebras', '基于 Cerebras 芯片的低延迟、高吞吐模型推理。', 'https://api.cerebras.ai/v1'),
  provider('cloudflare-ai-gateway', 'Cloudflare AI Gateway', '通过 Cloudflare 网关统一路由和治理多家模型。', null, { category: 'gateway', logo: 'cloudflare' }),
  provider('cloudflare-workers-ai', 'Cloudflare Workers AI', '在 Cloudflare 全球网络运行 GPU 加速模型。', null, { category: 'cloud', logo: 'cloudflare' }),
  provider('deepseek', 'DeepSeek', 'DeepSeek 推理与对话模型，兼顾编码能力与成本。', 'https://api.deepseek.com', { category: 'china' }),
  provider('fireworks', 'Fireworks AI', '快速的开源模型推理、多模态与函数调用服务。', 'https://api.fireworks.ai/inference', { category: 'cloud', logo: 'fireworks' }),
  provider('github-copilot', 'GitHub Copilot', '使用 GitHub Copilot 模型与订阅能力。', 'https://api.individual.githubcopilot.com', { category: 'subscription', logo: 'github' }),
  provider('google', 'Google Gemini', 'Google Gemini 多模态与通用推理模型。', 'https://generativelanguage.googleapis.com/v1beta', { logo: 'gemini', apiKeyLabel: 'Gemini API Key' }),
  provider('google-vertex', 'Google Vertex AI', '通过 Google Cloud Vertex AI 使用托管模型。', null, { category: 'cloud', authMode: 'ambient', logo: 'vertexai' }),
  provider('groq', 'Groq', 'Groq LPU 提供极低延迟的开源模型推理。', 'https://api.groq.com/openai/v1'),
  provider('huggingface', 'Hugging Face', '通过 Hugging Face Inference Router 访问开放模型。', 'https://router.huggingface.co/v1', { category: 'cloud', logo: 'huggingface', apiKeyLabel: 'Hugging Face Token' }),
  provider('hydite-vtslx-ao', 'Hydite Vtslx AO', 'Hydite 智能模型与加速推理服务。', 'https://api.hydite.com', { category: 'global', logo: 'hydite' }),
  provider('kimi-coding', 'Kimi For Coding', 'Moonshot Kimi 编码订阅计划。', 'https://api.kimi.com/coding', { category: 'subscription', logo: 'kimi', apiKeyLabel: 'Kimi Subscription Key' }),
  provider('minimax', 'MiniMax', 'MiniMax 全球站的长上下文与编码模型。', 'https://api.minimax.io/anthropic', { logo: 'minimax' }),
  provider('minimax-cn', 'MiniMax CN', 'MiniMax 中国站模型服务。', 'https://api.minimaxi.com/anthropic', { category: 'china', logo: 'minimax' }),
  provider('mistral', 'Mistral AI', 'Mistral 通用、专业与代码生成模型。', 'https://api.mistral.ai', { logo: 'mistral' }),
  provider('moonshotai', 'Moonshot AI', 'Moonshot Kimi 全球站模型 API。', 'https://api.moonshot.ai/v1', { logo: 'moonshot' }),
  provider('moonshotai-cn', 'Moonshot AI CN', '月之暗面 Kimi 中国站模型 API。', 'https://api.moonshot.cn/v1', { category: 'china', logo: 'moonshot' }),
  provider('nvidia', 'NVIDIA NIM', 'NVIDIA 托管的 GPU 加速推理微服务。', 'https://integrate.api.nvidia.com/v1', { category: 'cloud', logo: 'nvidia' }),
  provider('openai', 'OpenAI', 'OpenAI GPT、o 系列与 Codex 模型 API。', 'https://api.openai.com/v1', { logo: 'openai' }),
  provider('openai-codex', 'OpenAI Codex', '使用 ChatGPT Plus/Pro 订阅中的 Codex 模型。', 'https://chatgpt.com/backend-api', { category: 'subscription', authMode: 'oauth', logo: 'openai' }),
  provider('opencode', 'OpenCode Zen', '统一访问多家模型的 OpenCode Zen 服务。', null, { category: 'gateway', logo: 'opencode' }),
  provider('opencode-go', 'OpenCode Go', '按月订阅的开放编码模型服务。', null, { category: 'subscription', logo: 'opencode' }),
  provider('openrouter', 'OpenRouter', '通过单一 API 访问多家模型并进行路由。', 'https://openrouter.ai/api/v1', { category: 'gateway', logo: 'openrouter' }),
  provider('qwen-token-plan', 'Qwen Token Plan', '阿里云百炼国际站编程订阅计划。', 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1', { category: 'subscription', logo: 'qwen' }),
  provider('qwen-token-plan-cn', 'Qwen Token Plan CN', '阿里云百炼中国站编程订阅计划。', 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', { category: 'subscription', logo: 'qwen' }),
  provider('radius', 'Radius', 'Pi 的动态网关 Provider，可接入自定义兼容服务。', null, { category: 'gateway', logo: 'openrouter' }),
  provider('together', 'Together AI', '高性能开放模型推理与定制平台。', 'https://api.together.ai/v1', { category: 'cloud', logo: 'together' }),
  provider('vercel-ai-gateway', 'Vercel AI Gateway', '统一路由 100 多个模型并提供可观测性。', 'https://ai-gateway.vercel.sh', { category: 'gateway', logo: 'vercel' }),
  provider('xai', 'xAI', 'Grok 系列模型 API 与订阅能力。', 'https://api.x.ai/v1', { logo: 'xai' }),
  provider('xiaomi', 'Xiaomi MiMo', '小米 MiMo 对话与编码模型 API。', 'https://api.xiaomimimo.com/v1', { category: 'china', logo: 'xiaomi' }),
  provider('xiaomi-token-plan-ams', 'Xiaomi Token Plan AMS', '小米 MiMo 阿姆斯特丹订阅端点。', 'https://token-plan-ams.xiaomimimo.com/v1', { category: 'subscription', logo: 'xiaomi' }),
  provider('xiaomi-token-plan-cn', 'Xiaomi Token Plan CN', '小米 MiMo 中国站订阅端点。', 'https://token-plan-cn.xiaomimimo.com/v1', { category: 'subscription', logo: 'xiaomi' }),
  provider('xiaomi-token-plan-sgp', 'Xiaomi Token Plan SGP', '小米 MiMo 新加坡订阅端点。', 'https://token-plan-sgp.xiaomimimo.com/v1', { category: 'subscription', logo: 'xiaomi' }),
  provider('zai', 'Z.AI', '智谱 Z.AI 编码与推理模型。', 'https://api.z.ai/api/coding/paas/v4', { logo: 'zhipu' }),
  provider('zai-coding-cn', 'Z.AI Coding CN', '智谱 GLM Coding Plan 中国站。', 'https://open.bigmodel.cn/api/coding/paas/v4', { category: 'china', logo: 'zhipu' }),
] as const satisfies readonly AiProviderDefinition[]

export type AiProviderId = (typeof AI_PROVIDERS)[number]['id']

const providerMap = new Map<string, AiProviderDefinition>(AI_PROVIDERS.map((item) => [item.id, item]))

export function getAiProvider(providerId: string) {
  return providerMap.get(providerId) ?? null
}

export function isAiProviderId(providerId: string): providerId is AiProviderId {
  return providerMap.has(providerId)
}

export function providerLogoUrl(provider: Pick<AiProviderDefinition, 'logo'>) {
  return `https://models.dev/logos/${provider.logo}.svg`
}
