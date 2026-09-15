import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { Bell, MoreHorizontal, Settings, Trash2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"

const meta = { title: "UI/Overlays", parameters: { layout: "centered" } } satisfies Meta
export default meta
type Story = StoryObj<typeof meta>

export const OverlayGallery: Story = {
  render: () => <TooltipProvider><div className="flex min-h-64 flex-wrap items-center justify-center gap-4 p-10"><Tooltip><TooltipTrigger render={<Button variant="outline" />}><Bell />Hover for status</TooltipTrigger><TooltipContent>Notifications are enabled</TooltipContent></Tooltip><Popover><PopoverTrigger render={<Button variant="outline" />}>Open popover</PopoverTrigger><PopoverContent><PopoverHeader><PopoverTitle>Agent permissions</PopoverTitle><PopoverDescription>Choose how OpenLink handles workspace writes.</PopoverDescription></PopoverHeader><div className="rounded-md bg-muted p-3 text-xs">Current mode: ask before writes</div></PopoverContent></Popover><DropdownMenu><DropdownMenuTrigger render={<Button aria-label="More actions" size="icon" variant="outline" />}><MoreHorizontal /></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuLabel>Project actions</DropdownMenuLabel><DropdownMenuSeparator /><DropdownMenuItem><Settings />Settings</DropdownMenuItem><DropdownMenuItem className="text-destructive"><Trash2 />Archive project</DropdownMenuItem></DropdownMenuContent></DropdownMenu><Dialog><DialogTrigger render={<Button />}>Open dialog</DialogTrigger><DialogContent><DialogHeader><DialogTitle>Publish component update?</DialogTitle><DialogDescription>This makes the updated visual contract available to the OpenLink team.</DialogDescription></DialogHeader><DialogFooter><DialogClose render={<Button variant="outline" />}>Cancel</DialogClose><DialogClose render={<Button />}>Publish</DialogClose></DialogFooter></DialogContent></Dialog></div></TooltipProvider>,
}
