/**
 * Model logos are matched by *model name*, not by provider, because a single
 * provider (e.g. OpenCode Go) can serve models from many vendors and the
 * composer/dropdown should show the model's own brand. This module maps a
 * model name prefix to a brand slug understood by both `models.dev/logos`
 * (runtime images) and the LobeHub icon catalogue (client components).
 *
 * The mapping is deliberately prefix-based and case-insensitive so every
 * enabled model resolves to a sensible brand (防止遗漏), with the caller
 * falling back to the provider slug when nothing matches.
 */

const MODEL_NAME_LOGO_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^deepseek/i, 'deepseek'],
  [/^gemini/i, 'gemini'],
  [/^gemma/i, 'gemma'],
  [/^gpt-\d|^o[134](?:-|$)|^chatgpt|^gpt-oss/i, 'openai'],
  [/^claude/i, 'anthropic'],
  [/^qwen/i, 'qwen'],
  [/^kimi/i, 'moonshot'],
  [/^moonshot/i, 'moonshot'],
  [/^glm|^z.ai|^zai/i, 'zhipu'],
  [/^grok/i, 'xai'],
  [/^mistral|^mixtral|^codestral|^pixtral|^ministral|^devstral/i, 'mistral'],
  [/^llama|^meta-/i, 'meta'],
  [/^minimax/i, 'minimax'],
  [/^command(?:-|$)|^command-r/i, 'cohere'],
  [/^nvidia|^nemotron/i, 'nvidia'],
  [/^dbrx/i, 'dbrx'],
  [/^phi-/i, 'microsoft'],
  [/^doubao|^seed-/i, 'doubao'],
  [/^hunyuan/i, 'hunyuan'],
  [/^baichuan/i, 'baichuan'],
  [/^intern(?:lm)?/i, 'internlm'],
  [/^yi(?:-|$)/i, 'yi'],
  [/^ernie|^wenxin/i, 'baidu'],
  [/^spark/i, 'iflytek'],
  [/^solar/i, 'upstage'],
  [/^pixtral/i, 'mistral'],
  [/^gemini-|^gemma/i, 'gemini'],
]

/**
 * Resolve the brand slug for a model name. Returns `undefined` when no rule
 * matches so callers can fall back to the provider logo.
 */
export function modelLogoSlug(modelName: string): string | undefined {
  const name = modelName.trim()
  if (!name) return undefined
  for (const [pattern, slug] of MODEL_NAME_LOGO_RULES) {
    if (pattern.test(name)) return slug
  }
  return undefined
}
