import type { Meta, StoryObj } from "@storybook/nextjs-vite"

const swatches = [["Background", "--background"], ["Foreground", "--foreground"], ["Card", "--card"], ["Primary", "--primary"], ["Secondary", "--secondary"], ["Muted", "--muted"], ["Accent", "--accent"], ["Destructive", "--destructive"]] as const
const semanticSwatches = [["Success", "--app-success"], ["Warning", "--app-warning"], ["Information", "--app-info"], ["Inspector", "--app-inspector"], ["Brand", "--app-brand"]] as const

const meta = { title: "Foundations/Design Tokens", parameters: { layout: "fullscreen" } } satisfies Meta
export default meta
type Story = StoryObj<typeof meta>

function TokenCard({ label, token }: { label: string; token: string }) {
  return <article className="overflow-hidden rounded-xl border bg-card shadow-sm"><div className="h-24" style={{ background: `var(${token})` }} /><div className="p-3"><div className="text-sm font-medium">{label}</div><code className="mt-1 block text-[11px] text-muted-foreground">{token}</code></div></article>
}

export const ColorSystem: Story = {
  render: () => <main className="mx-auto w-full max-w-6xl p-8 md:p-12"><header className="mb-10 max-w-2xl"><p className="mb-3 text-xs font-semibold tracking-[0.14em] text-muted-foreground uppercase">Semantic foundations</p><h1 className="text-4xl font-semibold tracking-[-0.045em]">Color tokens</h1><p className="mt-3 text-sm leading-6 text-muted-foreground">Components consume semantic variables so the same surface remains legible across light and dark themes. Switch themes from the toolbar to inspect both.</p></header><section className="grid grid-cols-2 gap-4 md:grid-cols-4">{swatches.map(([label, token]) => <TokenCard key={token} label={label} token={token} />)}</section><h2 className="mt-12 mb-4 text-lg font-semibold">Status and product accents</h2><section className="grid grid-cols-2 gap-4 md:grid-cols-5">{semanticSwatches.map(([label, token]) => <TokenCard key={token} label={label} token={token} />)}</section></main>,
}

export const TypeAndSpacing: Story = {
  render: () => <main className="mx-auto grid w-full max-w-5xl gap-10 p-8 md:grid-cols-[1.2fr_.8fr] md:p-12"><section className="space-y-7"><div><div className="text-xs text-muted-foreground">Display / 48</div><p className="text-5xl font-semibold tracking-[-0.055em]">OpenLink ships ideas.</p></div><div><div className="text-xs text-muted-foreground">Heading / 30</div><p className="text-3xl font-semibold tracking-[-0.035em]">Build agents with confidence.</p></div><div><div className="text-xs text-muted-foreground">Body / 14</div><p className="max-w-xl text-sm leading-6">A compact interface voice for dense developer workflows, with enough rhythm to make state and hierarchy immediately understandable.</p></div><div><div className="text-xs text-muted-foreground">Code / 12</div><code className="mt-2 block rounded-lg bg-muted p-3 text-xs">pnpm storybook</code></div></section><section><h2 className="mb-5 text-sm font-semibold">Spacing rhythm</h2><div className="space-y-4">{[4, 8, 12, 16, 24, 32, 48, 64].map((size) => <div className="flex items-center gap-4" key={size}><code className="w-8 text-right text-[11px] text-muted-foreground">{size}</code><div className="h-4 rounded-sm bg-primary" style={{ width: size * 2 }} /></div>)}</div></section></main>,
}
