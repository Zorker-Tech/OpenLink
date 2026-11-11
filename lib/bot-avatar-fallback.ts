const COLOR_HEX: Record<string, string> = {
  black: '#111111',
  brown: '#A27952',
  red: '#FF3E51',
  orange: '#FF781C',
  yellow: '#FFAF38',
  green: '#00C972',
  cyan: '#1CC3B0',
  blue: '#2A92FE',
  violet: '#A97EFE',
  magenta: '#FF5EB1',
  gray: '#959595',
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;',
  })[character]!)
}

/** A deterministic, dependency-free fallback for a Bot whose rendered avatar is unavailable. */
export function fallbackBotAvatarSvg(name: string, color: string): string {
  const fill = COLOR_HEX[color] ?? COLOR_HEX.orange
  const initial = escapeXml(
    (Array.from(name.trim()).find((character) => /[\p{L}\p{N}]/u.test(character)) ?? 'B').toUpperCase(),
  )
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img" aria-label="${escapeXml(name)}">
  <defs>
    <radialGradient id="g" cx="38%" cy="28%" r="82%">
      <stop offset="0" stop-color="#ffffff" stop-opacity=".26"/>
      <stop offset=".58" stop-color="#ffffff" stop-opacity="0"/>
      <stop offset="1" stop-color="#000000" stop-opacity=".16"/>
    </radialGradient>
  </defs>
  <path fill="${fill}" d="M64 10c26 0 46 17 46 45v19c0 25-19 44-46 44S18 99 18 74V55c0-28 20-45 46-45Z"/>
  <path fill="url(#g)" d="M64 10c26 0 46 17 46 45v19c0 25-19 44-46 44S18 99 18 74V55c0-28 20-45 46-45Z"/>
  <ellipse cx="49" cy="62" rx="5" ry="11" fill="#fff"/>
  <ellipse cx="79" cy="62" rx="5" ry="11" fill="#fff"/>
  <text x="64" y="104" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" font-weight="600" fill="#fff" opacity=".82">${initial}</text>
</svg>`
}
