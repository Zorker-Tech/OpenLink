// Run inside the existing test Worker so its configured credential vault and
// egress policy remain authoritative. This does not change session settings.
const base = (process.env.OPENLINK_PROVIDER_BASE_URL ?? '').replace(/\/$/, '')
if (base !== 'https://opencode.ai/zen/go/v1') throw new Error('Probe target changed; refusing an unreviewed destination')
const key = process.env.OPENLINK_PROVIDER_API_KEY
if (!key) throw new Error('Configured Worker credential is unavailable')
for (const model of ['gpt-5.6-luna', 'minimax-m3']) {
  try {
    const response = await fetch(`${base}/responses`, {
      method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: 'Reply only OPENLINK_RESPONSES_PROBE_OK.', tools: [], store: false, max_output_tokens: 32 }),
      signal: AbortSignal.timeout(20000),
    })
    const text = await response.text()
    const classification = /unsupported_country_region_territory/.test(text) ? 'region_unavailable'
      : /not supported for format openai/.test(text) ? 'responses_format_unsupported'
        : response.ok ? 'accepted' : 'other_provider_failure'
    console.log(JSON.stringify({ timestamp: new Date().toISOString(), model, status: response.status, classification }))
  } catch (error) {
    console.log(JSON.stringify({ timestamp: new Date().toISOString(), model, classification: 'transport_failure', name: error instanceof Error ? error.name : 'unknown' }))
  }
}
