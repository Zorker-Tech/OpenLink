'use client'

import { PromptComposer } from '@/components/prompt-composer'
import { ZorkerLogo } from '@/components/zorker-logo'
import type { ComposerContext } from '@/lib/composer-context'
import {
  ArrowRight,
  ChevronDown,
  ExternalLink,
  Heart,
  Rocket,
  Sparkles,
  Users,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/utils/supabase/client'
import { theme } from '@/lib/theme'

interface HomeUser {
  email: string | null
  name: string | null
}

const templates = [
  {
    title: 'Image Generation Playground',
    image: '/openlink/template-1.png',
    avatar: '/openlink/avatar-1.png',
    views: '6.4K',
    likes: '708',
  },
  {
    title: 'Brillance SaaS Landing Page',
    image: '/openlink/template-2.png',
    avatar: '/openlink/avatar-2.png',
    views: '14K',
    likes: '2K',
  },
  {
    title: '3D Gallery Photography Template',
    image: '/openlink/template-3.png',
    avatar: '/openlink/avatar-3.png',
    views: '3.3K',
    likes: '851',
  },
  {
    title: 'Optimus - The AI platform to build and ship',
    image: '/openlink/template-4.png',
    avatar: '/openlink/avatar-4.png',
    views: '7.4K',
    likes: '1.2K',
  },
  {
    title: 'Grok Creative Studio',
    image: '/openlink/template-5.png',
    monogram: '▲',
    views: '1.1K',
    likes: '106',
  },
  {
    title: 'Globe To Map Transform',
    image: '/openlink/template-6.png',
    avatar: '/openlink/avatar-6.png',
    views: '2.2K',
    likes: '644',
  },
] as const

const mobileSites = [
  {
    title: 'Dashboard – M.O.N.K.Y',
    image: '/openlink/mobile-1.png',
    avatar: '/openlink/mobile-avatar-1.png',
    views: '7.5K',
    likes: '720',
  },
  {
    title: 'Garden City Game',
    image: '/openlink/mobile-2.png',
    avatar: '/openlink/mobile-avatar-2.png',
    views: '8',
    likes: '3',
  },
  {
    title: '3D Gallery Photography Template',
    image: '/openlink/mobile-3.png',
    avatar: '/openlink/mobile-avatar-3.png',
    views: '1.8K',
    likes: '397',
  },
] as const

const footerGroups = [
  { title: 'Product', links: ['Home', 'Enterprise', 'Pricing', 'v0 for Students'] },
  { title: 'Company', links: ['Terms', 'AI Policy', 'Privacy'] },
  { title: 'Resources', links: ['FAQs', 'Docs', 'Vercel Community', 'Vercel'] },
  { title: 'Social', links: ['Twitter', 'LinkedIn'] },
] as const

function Header({ user }: { user: HomeUser | null }) {
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const [isSigningOut, setIsSigningOut] = useState(false)

  const handleSignOut = async () => {
    setIsSigningOut(true)
    await supabase.auth.signOut()
    router.refresh()
    setIsSigningOut(false)
  }

  return (
    <header className={`fixed inset-x-0 top-0 z-50 flex h-[50px] items-center justify-between border-b px-2 ${theme('canvas', 'softBorder')}`}>
      <a aria-label="Zorker home" className="flex h-10 w-9 items-center justify-center rounded-lg" href="#">
        <ZorkerLogo className="h-5 w-[34px]" />
      </a>

      <nav aria-label="Main navigation" className="absolute left-1/2 hidden -translate-x-1/2 items-center gap-1 md:flex">
        <a className="nav-link w-[101px] justify-center gap-1" href="#templates">
          Templates <ChevronDown className="size-3" />
        </a>
        <a className="nav-link w-[84px] justify-center" href="#enterprise">Enterprise</a>
        <a className="nav-link w-[62px] justify-center" href="#pricing">Pricing</a>
        <a className="nav-link w-[39px] justify-center" href="#ios">iOS</a>
        <a className="nav-link w-[76px] justify-center" href="#students">Students</a>
        <a className="nav-link w-[43px] justify-center" href="#faq">FAQ</a>
      </nav>

      {user ? (
        <div className="flex items-center gap-2">
          <a className={`hidden max-w-[180px] truncate rounded-md px-2 py-1 text-sm transition-colors hover:text-[var(--app-foreground)] sm:block ${theme('muted', 'hover')}`} href="/app" title={user.email ?? user.name ?? undefined}>
            {user.name ?? user.email ?? '已登录'}
          </a>
          <button
            className={`flex h-8 items-center rounded-lg border px-3 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${theme('surface', 'border', 'hover')}`}
            disabled={isSigningOut}
            onClick={handleSignOut}
            type="button"
          >
            {isSigningOut ? '退出中…' : '退出'}
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <a className={`flex h-8 items-center rounded-lg border px-3 text-sm font-medium transition-colors ${theme('surface', 'border', 'hover')}`} href="/login">
            登录
          </a>
          <a className={`flex h-8 items-center rounded-lg border border-[var(--app-submit-background)] px-3 text-sm font-medium transition-colors ${theme('action', 'actionHover')}`} href="/register">
            注册
          </a>
        </div>
      )}
    </header>
  )
}

function Hero({ user, composerContext }: { user: HomeUser | null; composerContext: ComposerContext | null }) {
  return (
    <section className="h-[493px] px-6 pt-36">
      <h1 className="mb-4 text-center text-[32px] leading-10 font-semibold tracking-[-0.8737px] text-[var(--app-foreground)]">
        您想创建什么？
      </h1>
      <PromptComposer user={user} composerContext={composerContext} />
    </section>
  )
}

function Stats({ views, likes }: { views: string; likes: string }) {
  return (
    <div className={`flex items-center gap-1.5 text-[13px] leading-[13px] ${theme('muted')}`}>
      <span className="flex items-center gap-1.5"><Users className="size-3" />{views}</span>
      <span aria-hidden="true" className={theme('subtle')}>·</span>
      <span className="flex items-center gap-1.5"><Heart className="size-3" />{likes}</span>
    </div>
  )
}

function TemplateCard({ template }: { template: (typeof templates)[number] }) {
  return (
    <article className="group min-w-0">
      <a className={`block aspect-[1.777] overflow-hidden rounded-lg ring-1 ring-[var(--app-control-border)] ${theme('editor')}`} href="#">
        <img alt={template.title} className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.02]" src={template.image} />
      </a>
      <div className="mt-2 flex h-9 items-center gap-3 pr-1">
        {'avatar' in template ? (
          <img alt="Creator avatar" className="size-9 rounded-full object-cover" src={template.avatar} />
        ) : (
          <span className={`flex size-9 items-center justify-center rounded-full text-lg ${theme('action')}`}>{template.monogram}</span>
        )}
        <div className="min-w-0">
          <a className="block truncate text-sm leading-[14px] font-medium tracking-[-0.1504px] text-[var(--app-foreground)] hover:underline" href="#">
            {template.title}
          </a>
          <div className="mt-1.5"><Stats likes={template.likes} views={template.views} /></div>
        </div>
      </div>
    </article>
  )
}

function TemplatesSection() {
  return (
    <section className="mx-auto max-w-[1264px] px-6" id="templates">
      <div className="mb-6 flex items-center justify-between gap-6">
        <h2 className="shrink-0 text-2xl leading-8 font-semibold tracking-[-0.8897px] text-[var(--app-foreground)]">Start with a template</h2>
        <a className={`flex h-8 w-[108px] items-center justify-center gap-1.5 rounded-lg text-sm font-medium lg:ml-auto ${theme('hover')}`} href="#">
          Browse all <ArrowRight className="size-4" />
        </a>
      </div>
      <div className="grid grid-cols-1 gap-x-6 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
        {templates.map((template) => <TemplateCard key={template.title} template={template} />)}
      </div>
      <div className="flex justify-center pt-9">
        <a className={`flex h-10 items-center rounded-lg border px-4 text-sm font-medium ${theme('surface', 'border', 'hover')}`} href="#">Browse all</a>
      </div>
    </section>
  )
}

function OrbitVisual() {
  const labels = ['Web', 'Plan', 'DB', 'API', 'Deploy', 'LLM']
  return (
    <div className="relative mx-auto h-60 w-[336px] max-w-full">
      <div className="absolute inset-[28px_44px] rounded-full border border-dashed border-[var(--app-control-border)]" />
      {labels.map((label, index) => {
        const positions = ['left-1/2 top-3 -translate-x-1/2', 'right-4 top-[58px]', 'right-6 bottom-[58px]', 'left-1/2 bottom-3 -translate-x-1/2', 'left-2 bottom-[58px]', 'left-4 top-[58px]']
        return <span className={`absolute rounded border px-3 py-2 font-mono text-[10px] ${positions[index]} ${theme('elevated', 'border')}`} key={label}>{label}</span>
      })}
      <div className={`absolute left-1/2 top-1/2 flex size-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border ${theme('elevated', 'border')}`}><Sparkles className="size-7" /></div>
    </div>
  )
}

function FeatureCard({ title, body, visual, lead = false }: { title: ReactNode; body: string; visual?: ReactNode; lead?: boolean }) {
  return (
    <article className={`overflow-hidden rounded-2xl border ${theme('surface', 'softBorder')} ${lead ? 'flex items-center' : ''}`}>
      <div className={lead ? 'p-8' : 'px-8 pt-8 pb-4'}>
        <h3 className={lead ? 'text-5xl leading-14 font-semibold tracking-[-2.5284px] text-[var(--app-foreground)]' : 'text-xl leading-[26px] font-semibold tracking-[-0.8492px] text-[var(--app-foreground)]'}>{title}</h3>
        <p className="max-w-md pt-2 text-base leading-6 tracking-[-0.3125px] text-[var(--app-muted)]">{body}</p>
      </div>
      {visual}
    </article>
  )
}

function FeaturesSection() {
  return (
    <section className="mx-auto mt-[72px] max-w-[1264px] px-6 pb-20">
      <div className="feature-grid">
        <FeatureCard body="Generate working applications in minutes with AI. Publish as live websites in seconds." lead title={<>Prompt.<br />Build. Publish.</>} />
        <FeatureCard body="Connect to GitHub and push code directly to your repository." title="Sync with a repo" visual={<div className="flex flex-1 items-center justify-center gap-10"><span className="visual-orb"><img alt="GitHub" className="size-11" src="/openlink/github.svg" /></span><span className="visual-orb"><ZorkerLogo className="h-6 w-10" /></span></div>} />
        <FeatureCard body="Build with your favorite tools and APIs. Automatic integration, no accounts required." title="Integrate with apps" visual={<div className="app-cloud">{['AI', 'DB', 'API', 'UI', 'CMS', 'Git'].map((item) => <span key={item}>{item}</span>)}</div>} />
        <FeatureCard body="Go live instantly with one-click deployment to production in seconds." title="Deploy to Vercel" visual={<div className="flex flex-1 items-center justify-center"><Rocket className="size-24 text-[var(--app-foreground)]" strokeWidth={1} /></div>} />
        <FeatureCard body="Fine-tune every detail with visual controls and live preview." title="Edit with design mode" visual={<div className="design-window"><span /><span /><span /><div /></div>} />
        <FeatureCard body="Launch faster with ready-made components and full-page designs." title="Start with templates" visual={<div className="mini-template-grid">{templates.slice(0, 4).map((item) => <img alt="" key={item.title} src={item.image} />)}</div>} />
        <FeatureCard body="Define colors, typography, and styles that you can use across projects." title="Create design systems" visual={<div className="type-specimen"><span>Aa</span><i /><i /><i /></div>} />
        <FeatureCard body="v0 plans, creates tasks, and connects to databases as it builds." title="Agentic by default" visual={<OrbitVisual />} />
        <FeatureCard body="Build anywhere with the v0 iOS app. Design on the go." title="Create from your phone" visual={<div className="relative mx-auto h-[280px] w-[267px] overflow-hidden"><img alt="iPhone" className="absolute inset-x-0 top-0 w-full" src="/openlink/iphone.png" /><img alt="OpenLink iOS app" className="absolute left-[16px] top-[15px] w-[234px] rounded-[34px]" src="/openlink/ios-app.png" /></div>} />
      </div>
    </section>
  )
}

function BrandStrip() {
  const brands = Array.from({ length: 6 }, (_, index) => `/openlink/brand-${index + 1}.svg`)
  return (
    <section aria-label="Trusted brands" className="brand-strip mx-auto mt-[72px] h-[200px] max-w-[1264px] overflow-hidden py-20">
      <div className="brand-track">
        {[...brands, ...brands].map((brand, index) => <img alt="Brand logo" className="h-10 w-auto max-w-[148px] shrink-0" key={`${brand}-${index}`} src={brand} />)}
      </div>
    </section>
  )
}

function MobileGallery() {
  return (
    <section className="mx-auto mt-[72px] max-w-[1264px] px-6 py-20" id="ios">
      <div className="flex items-center justify-between">
        <h2 className="text-[32px] leading-10 font-semibold tracking-[-0.8737px] text-[var(--app-foreground)]">Ship mobile sites</h2>
        <a className="flex items-center gap-1.5 text-sm font-medium text-[var(--app-foreground)]" href="#">Browse all <ArrowRight className="size-4" /></a>
      </div>
      <div className="mt-12 flex gap-4 overflow-x-auto pb-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {mobileSites.map((site) => (
          <article className="w-[340px] shrink-0" key={site.title}>
            <a className={`block h-[722px] overflow-hidden rounded-xl border ring-1 ring-[var(--app-control-border)] ${theme('editor', 'softBorder')}`} href="#">
              <img alt={site.title} className="size-full object-cover object-top" src={site.image} />
            </a>
            <div className="flex h-[46px] items-center gap-3 pt-2">
              <img alt="Creator avatar" className="size-9 rounded-full object-cover" src={site.avatar} />
              <div className="min-w-0"><p className="truncate text-base leading-4 font-medium text-[var(--app-foreground)]">{site.title}</p><div className="mt-1.5"><Stats likes={site.likes} views={site.views} /></div></div>
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}

function CallToAction() {
  return (
    <section className="mx-auto mt-[72px] max-w-[1264px] px-6 pt-24 pb-40 text-center">
      <div className="rounded-2xl px-12 py-16">
        <h2 className="text-5xl leading-14 font-semibold tracking-[-2.5284px] text-[var(--app-foreground)]">Start building with v0</h2>
        <p className="pt-2 text-lg leading-7 tracking-[-0.4395px] text-[var(--app-muted)]">Go from idea to production in seconds with smart, secure infrastructure</p>
        <a className={`mx-auto mt-8 flex h-12 w-fit items-center rounded-full border border-[var(--app-submit-background)] px-5 text-base font-medium ${theme('action', 'actionHover')}`} href="#">Get Started</a>
      </div>
    </section>
  )
}

function Footer() {
  return (
    <footer className="px-6 py-16">
      <div className="mx-auto flex min-h-[226px] max-w-[1400px] items-start justify-between gap-16 px-[60px] pt-6 pb-10">
        <a aria-label="Zorker home" className="flex h-8 items-center" href="#"><ZorkerLogo className="h-7 w-[95px]" variant="wordmark" /></a>
        <div className="grid flex-1 grid-cols-2 gap-12 sm:grid-cols-4 lg:max-w-[870px] lg:gap-[108px]">
          {footerGroups.map((group) => (
            <div key={group.title}>
              <h2 className="text-sm leading-5 font-medium text-[var(--app-foreground)]">{group.title}</h2>
              <ul className="mt-4 space-y-2.5">
                {group.links.map((link) => <li key={link}><a className="inline-flex items-center gap-0.5 whitespace-nowrap text-sm leading-6 text-[var(--app-muted)] hover:text-[var(--app-foreground)]" href="#">{link}{['Terms', 'Privacy', 'Vercel Community', 'Vercel'].includes(link) && <ExternalLink className="size-4" />}</a></li>)}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </footer>
  )
}

export function OpenLinkHome({ user, composerContext }: { user: HomeUser | null; composerContext: ComposerContext | null }) {
  return (
    <div className={`min-h-screen overflow-x-hidden pt-[50px] ${theme('canvas')}`}>
      <Header user={user} />
      <main>
        <Hero user={user} composerContext={composerContext} />
        <TemplatesSection />
        <FeaturesSection />
        <BrandStrip />
        <MobileGallery />
        <CallToAction />
      </main>
      <Footer />
    </div>
  )
}
