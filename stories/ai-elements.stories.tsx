import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { FileCode2, RotateCcw } from "lucide-react"

import { Artifact, ArtifactAction, ArtifactActions, ArtifactContent, ArtifactDescription, ArtifactHeader, ArtifactTitle } from "@/components/ai-elements/artifact"
import { FileTree, FileTreeFile, FileTreeFolder } from "@/components/ai-elements/file-tree"
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message"
import { Plan, PlanContent, PlanDescription, PlanFooter, PlanHeader, PlanTitle, PlanTrigger } from "@/components/ai-elements/plan"
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning"
import { Source, Sources, SourcesContent, SourcesTrigger } from "@/components/ai-elements/sources"
import { StackTrace, StackTraceActions, StackTraceContent, StackTraceCopyButton, StackTraceError, StackTraceErrorMessage, StackTraceErrorType, StackTraceExpandButton, StackTraceFrames, StackTraceHeader } from "@/components/ai-elements/stack-trace"
import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion"
import { Task, TaskContent, TaskItem, TaskItemFile, TaskTrigger } from "@/components/ai-elements/task"
import { Terminal } from "@/components/ai-elements/terminal"
import { Button } from "@/components/ui/button"

const meta = { title: "AI Elements/Pattern Gallery", parameters: { layout: "fullscreen" } } satisfies Meta
export default meta
type Story = StoryObj<typeof meta>

export const ConversationStates: Story = {
  render: () => <main className="mx-auto w-full max-w-3xl space-y-7 p-8 md:p-12"><Message from="user"><MessageContent>Give OpenLink a complete component library and keep the visual language consistent.</MessageContent></Message><Message from="assistant"><MessageContent><Reasoning defaultOpen><ReasoningTrigger>Mapped the reusable UI surface</ReasoningTrigger><ReasoningContent>Inventory primitives, AI elements and product compositions; isolate backend-bound surfaces from standalone examples.</ReasoningContent></Reasoning><MessageResponse>{"I’ll establish a Storybook workshop with real light/dark tokens, interaction states, accessibility checks and a generated component inventory."}</MessageResponse></MessageContent></Message><Sources><SourcesTrigger count={2} /><SourcesContent><Source href="https://storybook.js.org/docs" title="Storybook documentation" /><Source href="https://github.com/storybookjs/storybook" title="storybookjs/storybook" /></SourcesContent></Sources><Suggestions><Suggestion suggestion="Show the dark theme" /><Suggestion suggestion="Inspect accessibility" /><Suggestion suggestion="Review component states" /></Suggestions></main>,
}

export const AgentWork: Story = {
  render: () => <main className="mx-auto grid w-full max-w-5xl gap-6 p-8 md:grid-cols-2 md:p-12"><Plan defaultOpen><PlanHeader><div><PlanTitle>Component library rollout</PlanTitle><PlanDescription>Build, verify, then make the catalog part of daily UI development.</PlanDescription></div><PlanTrigger /></PlanHeader><PlanContent><ol className="list-decimal space-y-2 pl-5 text-sm"><li>Map reusable components</li><li>Author representative states</li><li>Run browser and accessibility checks</li></ol></PlanContent><PlanFooter className="justify-between"><span className="text-xs text-muted-foreground">2 of 3 complete</span><Button size="sm">Continue</Button></PlanFooter></Plan><div className="space-y-4"><Task><TaskTrigger title="Searched component sources" /><TaskContent><TaskItem>Found shared controls in <TaskItemFile>components/ui</TaskItemFile></TaskItem><TaskItem>Found agent surfaces in <TaskItemFile>components/ai-elements</TaskItemFile></TaskItem></TaskContent></Task><Artifact><ArtifactHeader><div><ArtifactTitle>ui-primitives.stories.tsx</ArtifactTitle><ArtifactDescription>Interactive primitive gallery</ArtifactDescription></div><ArtifactActions><ArtifactAction icon={RotateCcw} label="Restore" /></ArtifactActions></ArtifactHeader><ArtifactContent className="flex min-h-32 items-center justify-center bg-muted/40"><FileCode2 className="mr-2 size-5" />Story ready for review</ArtifactContent></Artifact></div></main>,
}

export const DeveloperSurfaces: Story = {
  render: () => <main className="mx-auto grid w-full max-w-6xl gap-6 p-8 lg:grid-cols-[.7fr_1.3fr] md:p-12"><FileTree defaultExpanded={new Set(["components", "components/ui"])} selectedPath="components/ui/button.tsx"><FileTreeFolder name="components" path="components"><FileTreeFolder name="ui" path="components/ui"><FileTreeFile name="button.tsx" path="components/ui/button.tsx" /><FileTreeFile name="card.tsx" path="components/ui/card.tsx" /></FileTreeFolder><FileTreeFolder name="ai-elements" path="components/ai-elements"><FileTreeFile name="message.tsx" path="components/ai-elements/message.tsx" /></FileTreeFolder></FileTreeFolder></FileTree><div className="space-y-6"><Terminal output={"$ pnpm storybook:build\n✓ story canvases compiled\n✓ accessibility addon ready\n✓ component inventory generated"} /><StackTrace defaultOpen trace={"TypeError: Cannot read properties of undefined\n    at renderStory (/app/stories/preview.tsx:42:12)\n    at runComponentTest (/app/node_modules/vitest/index.js:120:8)"}><StackTraceHeader><StackTraceError><StackTraceErrorType /><StackTraceErrorMessage /></StackTraceError><StackTraceActions><StackTraceCopyButton /><StackTraceExpandButton /></StackTraceActions></StackTraceHeader><StackTraceContent><StackTraceFrames /></StackTraceContent></StackTrace></div></main>,
}
