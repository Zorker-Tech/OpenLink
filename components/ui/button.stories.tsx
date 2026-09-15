import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { ArrowRight } from "lucide-react"

import { Button } from "./button"

const meta = {
  title: "UI/Button",
  component: Button,
  args: {
    children: "Create project",
    disabled: false,
    size: "default",
    variant: "default",
  },
  argTypes: {
    size: { control: "select", options: ["xs", "sm", "default", "lg", "icon", "icon-xs", "icon-sm", "icon-lg"] },
    variant: { control: "select", options: ["default", "secondary", "outline", "ghost", "destructive", "link"] },
  },
  parameters: {
    docs: {
      description: {
        component: "The primary action primitive for OpenLink. Prefer one default action per decision surface and use semantic variants for hierarchy.",
      },
    },
  },
} satisfies Meta<typeof Button>

export default meta
type Story = StoryObj<typeof meta>

export const Playground: Story = {}
export const WithIcon: Story = { args: { children: <><span>Continue</span><ArrowRight data-icon="inline-end" /></> } }
export const Loading: Story = { args: { children: "Creating…", disabled: true } }
export const Destructive: Story = { args: { children: "Delete project", variant: "destructive" } }
