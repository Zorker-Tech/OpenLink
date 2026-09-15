import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { AlertCircle, ArrowRight, Check, Plus, Sparkles } from "lucide-react"
import { useState } from "react"

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { AppSelect } from "@/components/ui/app-select"
import { Avatar, AvatarBadge, AvatarFallback, AvatarGroup, AvatarGroupCount } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Progress, ProgressLabel, ProgressValue } from "@/components/ui/progress"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"

const meta = { title: "UI/Primitive Gallery", parameters: { layout: "fullscreen" } } satisfies Meta
export default meta
type Story = StoryObj<typeof meta>

const variants = ["default", "secondary", "outline", "ghost", "destructive", "link"] as const
const sizes = ["xs", "sm", "default", "lg"] as const

export const Actions: Story = {
  render: () => <main className="mx-auto w-full max-w-5xl space-y-10 p-8 md:p-12"><header><h1 className="text-3xl font-semibold tracking-[-0.04em]">Actions</h1><p className="mt-2 text-sm text-muted-foreground">Variants, sizes, grouping and loading states.</p></header><section><h2 className="mb-4 text-sm font-semibold">Variants</h2><div className="flex flex-wrap gap-3">{variants.map((variant) => <Button key={variant} variant={variant}>{variant}</Button>)}</div></section><section><h2 className="mb-4 text-sm font-semibold">Scale and icons</h2><div className="flex flex-wrap items-center gap-3">{sizes.map((size) => <Button key={size} size={size}><Sparkles data-icon="inline-start" />{size}</Button>)}<Button aria-label="Add" size="icon"><Plus /></Button><Button disabled><Spinner />Working</Button></div></section><section><h2 className="mb-4 text-sm font-semibold">Button group</h2><ButtonGroup><Button variant="outline">Preview</Button><Button variant="outline">Publish</Button><Button aria-label="Continue" size="icon" variant="outline"><ArrowRight /></Button></ButtonGroup></section><section><h2 className="mb-4 text-sm font-semibold">Badges</h2><div className="flex flex-wrap gap-2">{variants.map((variant) => <Badge key={variant} variant={variant}><Check />{variant}</Badge>)}</div></section></main>,
}

function FormExample() {
  const [model, setModel] = useState("cauiril-auto")
  return <div className="grid gap-5 rounded-2xl border bg-card p-6 shadow-sm"><label className="grid gap-2 text-sm font-medium">Project name<Input defaultValue="OpenLink UI" /></label><label className="grid gap-2 text-sm font-medium">Instructions<Textarea defaultValue="Keep the interface compact, legible and honest about runtime state." rows={4} /></label><label className="grid gap-2 text-sm font-medium">Default model<AppSelect ariaLabel="Default model" onValueChange={setModel} options={[{ label: "Cauiril Auto", value: "cauiril-auto", description: "Adaptive routing" }, { label: "Hydite Code", value: "hydite-code", description: "Code-specialized" }]} value={model} /></label><Separator /><label className="flex items-center justify-between gap-6 text-sm"><span><span className="block font-medium">Automatic context</span><span className="text-muted-foreground">Attach the current workspace state.</span></span><Switch defaultChecked /></label></div>
}

export const Forms: Story = {
  render: () => <main className="mx-auto w-full max-w-xl p-8 md:p-12"><FormExample /></main>,
}

export const FeedbackAndData: Story = {
  render: () => <main className="mx-auto w-full max-w-3xl space-y-5 p-8 md:p-12"><Alert><Check /><AlertTitle>Runtime ready</AlertTitle><AlertDescription>The project workspace is connected and ready for agent work.</AlertDescription><AlertAction><Badge variant="outline">Healthy</Badge></AlertAction></Alert><Alert variant="destructive"><AlertCircle /><AlertTitle>Provider unavailable</AlertTitle><AlertDescription>Execution is blocked by the upstream provider. Local work remains saved.</AlertDescription><AlertAction><Button size="xs" variant="outline">Details</Button></AlertAction></Alert><Card><CardHeader><CardTitle>Release qualification</CardTitle><CardDescription>Static analysis, component tests and visual review.</CardDescription><CardAction><Badge variant="secondary">3 / 4</Badge></CardAction></CardHeader><CardContent><Progress value={75}><ProgressLabel>Validation</ProgressLabel><ProgressValue /></Progress></CardContent><CardFooter className="justify-between"><AvatarGroup><Avatar><AvatarFallback>YK</AvatarFallback><AvatarBadge /></Avatar><Avatar><AvatarFallback>OL</AvatarFallback></Avatar><AvatarGroupCount>+3</AvatarGroupCount></AvatarGroup><span className="text-xs text-muted-foreground">Updated moments ago</span></CardFooter></Card><Tabs defaultValue="overview"><TabsList><TabsTrigger value="overview">Overview</TabsTrigger><TabsTrigger value="activity">Activity</TabsTrigger><TabsTrigger value="settings">Settings</TabsTrigger></TabsList><TabsContent className="rounded-xl border p-5" value="overview">The overview keeps status, ownership and next actions together.</TabsContent><TabsContent className="rounded-xl border p-5" value="activity">Recent component changes appear here.</TabsContent><TabsContent className="rounded-xl border p-5" value="settings">Library preferences appear here.</TabsContent></Tabs></main>,
}
