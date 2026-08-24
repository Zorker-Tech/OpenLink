"use client"

import { Switch as SwitchPrimitive } from "@base-ui/react/switch"

import { cn } from "@/lib/utils"

function Switch({
  className,
  size = "default",
  ...props
}: SwitchPrimitive.Root.Props & {
  size?: "card" | "sm" | "default"
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        "peer group/switch relative inline-flex shrink-0 items-center rounded-full border border-transparent transition-[background-color,box-shadow] outline-none after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:border-[var(--app-focus-ring)] focus-visible:ring-2 focus-visible:ring-[var(--app-focus-ring)]/35 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-[size=card]:h-4 data-[size=card]:w-7 data-[size=card]:p-0.5 data-[size=default]:h-[18.4px] data-[size=default]:w-[32px] data-[size=sm]:h-[14px] data-[size=sm]:w-[24px] dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 data-checked:bg-[var(--app-brand)] data-unchecked:bg-[var(--app-active,var(--input))] data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block rounded-full bg-[var(--app-background,var(--background))] ring-0 shadow-[0_1px_1px_var(--app-shadow),0_3px_8px_var(--app-shadow)] transition-transform group-data-[size=card]/switch:size-3 group-data-[size=default]/switch:size-4 group-data-[size=sm]/switch:size-3 group-data-[size=card]/switch:data-checked:translate-x-3 group-data-[size=default]/switch:data-checked:translate-x-[calc(100%-2px)] group-data-[size=sm]/switch:data-checked:translate-x-[calc(100%-2px)] group-data-checked/switch:bg-[var(--app-surface)] group-data-[size=card]/switch:data-unchecked:translate-x-0 group-data-[size=default]/switch:data-unchecked:translate-x-0 group-data-[size=sm]/switch:data-unchecked:translate-x-0"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
