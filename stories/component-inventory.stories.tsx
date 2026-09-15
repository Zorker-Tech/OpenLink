import type { Meta, StoryObj } from "@storybook/nextjs-vite"

import componentFiles from "./generated/component-inventory.json"
import coverageReport from './generated/component-coverage.json'

const definitions = [
  { key: "ui", label: "UI primitives", description: "Buttons, fields, overlays, layout and feedback primitives.", match: (path: string) => path.startsWith("ui/") },
  { key: "ai", label: "AI elements", description: "Reusable agent, chat, tool and generation surfaces.", match: (path: string) => path.startsWith("ai-elements/") },
  { key: "workbench", label: "Workbenches", description: "Browser, code-server and settings workbenches.", match: (path: string) => path.includes("/") },
  { key: "product", label: "Product components", description: "OpenLink product composition and application-level surfaces.", match: () => true },
]

const groups = definitions.map((group, index) => ({
  ...group,
  files: componentFiles.filter((path) => group.match(path) && !definitions.slice(0, index).some((previous) => previous.match(path))),
}))

const meta = {
  title: "Start Here/Component Inventory",
  parameters: {
    docs: { description: { component: "Generated from reusable React component modules under `components/`; demo bootstraps and their private children are intentionally excluded. The inventory updates automatically when files change." } },
    layout: "fullscreen",
  },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

export const Catalog: Story = {
  render: () => {
    const reusableCount = groups.filter((group) => group.key === "ui" || group.key === "ai").reduce((total, group) => total + group.files.length, 0)
    return (
      <main className="catalog-shell">
        <section className="catalog-hero">
          <div className="catalog-kicker"><span className="catalog-kicker-dot" /> OpenLink design system</div>
          <h1 className="catalog-title">Build one visual language.</h1>
          <p className="catalog-summary">A live workshop for OpenLink primitives, AI interaction patterns and product surfaces. Use theme, viewport, accessibility and component testing tools before a UI change enters the application.</p>
        </section>
        <section className="catalog-stats" aria-label="Component library summary">
          <article className="catalog-stat"><span className="catalog-stat-value">{componentFiles.length}</span><div className="catalog-stat-label">Reusable React modules indexed</div></article>
          <article className="catalog-stat"><span className="catalog-stat-value">{reusableCount}</span><div className="catalog-stat-label">Reusable UI and AI modules</div></article>
          <article className="catalog-stat"><span className="catalog-stat-value">2</span><div className="catalog-stat-label">First-class light and dark themes</div></article>
        </section>
        <section className="catalog-grid" aria-label="Component groups">
          {groups.map((group) => (
            <article className="catalog-group" key={group.key}>
              <header className="catalog-group-head"><div><h2 className="catalog-group-title">{group.label}</h2><p className="mt-1 text-xs leading-5 text-muted-foreground">{group.description}</p></div><span className="catalog-count">{group.files.length}</span></header>
              <div className="catalog-files">{group.files.map((file) => <span className="catalog-file" key={file}>{file}</span>)}</div>
            </article>
          ))}
        </section>
      </main>
    )
  },
}

export const Coverage: Story = {
  render: () => {
    const storyLinkLimit = 4
    return <main className="catalog-shell">
      <h1 className="text-2xl font-semibold">组件与故事覆盖</h1>
      <p className="my-4 text-sm text-muted-foreground">{coverageReport.modules} 个可复用模块 · {coverageReport.stories} 个故事 · {coverageReport.direct} 个直接入口 · {coverageReport.composition} 个通过组合引用。覆盖只统计真实源组件，不代表所有运行时和状态组合已验收。</p>
      <p className="mb-6 text-sm">远程运行时使用明确标注的本地 fixtures；媒体权限和外部 Rive 资源需要手动验收。thinking demo 仅作为演示入口，不计入可复用组件清单。</p>
      <div className="overflow-x-auto rounded-xl border">
        <table className="min-w-[760px] w-full table-fixed text-left text-sm"><colgroup><col className="w-[28%]" /><col className="w-[110px]" /><col /></colgroup><thead><tr className="border-b"><th className="p-3">源组件</th><th className="whitespace-nowrap p-3">接入方式</th><th className="p-3">调试入口</th></tr></thead><tbody>{coverageReport.coverage.map(row => {
          const storyLinks = row.entries.flatMap(entry => entry.stories.map(story => ({ key: `${entry.file}:${story.id}`, id: story.id, label: `${entry.title} / ${story.name}` })))
          const visibleLinks = storyLinks.slice(0, storyLinkLimit)
          const hiddenLinks = storyLinks.slice(storyLinkLimit)
          return <tr key={row.module} className="border-b last:border-0"><td className="p-3 font-mono text-xs">{row.module}</td><td className="whitespace-nowrap p-3">{({ direct: '直接故事', composition: '组合引用', missing: '待接入' } as Record<string, string>)[row.status]}</td><td className="p-3">{visibleLinks.map(story => <a className="mr-3 inline-block text-blue-500 underline" key={story.key} href={`?path=/story/${story.id}`} target="_top">{story.label}</a>)}{hiddenLinks.length ? <details className="mt-1 inline-block align-top text-xs"><summary className="cursor-pointer text-muted-foreground">+{hiddenLinks.length} 个故事</summary><div className="mt-2 grid gap-1">{hiddenLinks.map(story => <a className="text-blue-500 underline" key={story.key} href={`?path=/story/${story.id}`} target="_top">{story.label}</a>)}</div></details> : null}{row.reason}</td></tr>
        })}</tbody></table>
      </div>
    </main>
  },
}
