import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { ComponentProps, ReactNode } from "react";

export type ModelSelectorProps = ComponentProps<typeof DropdownMenu>;

export const ModelSelector = (props: ModelSelectorProps) => (
  <DropdownMenu {...props} />
);

export type ModelSelectorTriggerProps = ComponentProps<typeof DropdownMenuTrigger>;

export const ModelSelectorTrigger = (props: ModelSelectorTriggerProps) => (
  <DropdownMenuTrigger {...props} />
);

export type ModelSelectorContentProps = ComponentProps<typeof DropdownMenuContent> & {
  title?: ReactNode;
};

export const ModelSelectorContent = ({
  className,
  children,
  title = "Model Selector",
  ...props
}: ModelSelectorContentProps) => (
  <DropdownMenuContent
    aria-describedby={undefined}
    className={cn(
      "z-50 rounded-xl border border-[var(--app-border)] bg-[var(--app-elevated)] p-1 text-[var(--app-foreground)] shadow-[0_12px_36px_var(--app-shadow)]",
      className
    )}
    {...props}
  >
    <span className="sr-only">{title}</span>
    <Command className="**:data-[slot=command-input-wrapper]:h-auto">
      {children}
    </Command>
  </DropdownMenuContent>
);

export type ModelSelectorDialogProps = ComponentProps<typeof CommandDialog>;

export const ModelSelectorDialog = (props: ModelSelectorDialogProps) => (
  <CommandDialog {...props} />
);

export type ModelSelectorInputProps = ComponentProps<typeof CommandInput>;

export const ModelSelectorInput = ({
  className,
  ...props
}: ModelSelectorInputProps) => (
  <CommandInput className={cn("h-auto py-3.5", className)} {...props} />
);

export type ModelSelectorListProps = ComponentProps<typeof CommandList>;

export const ModelSelectorList = (props: ModelSelectorListProps) => (
  <CommandList {...props} />
);

export type ModelSelectorEmptyProps = ComponentProps<typeof CommandEmpty>;

export const ModelSelectorEmpty = (props: ModelSelectorEmptyProps) => (
  <CommandEmpty {...props} />
);

export type ModelSelectorGroupProps = ComponentProps<typeof CommandGroup>;

export const ModelSelectorGroup = (props: ModelSelectorGroupProps) => (
  <CommandGroup {...props} />
);

export type ModelSelectorItemProps = ComponentProps<typeof CommandItem>;

export const ModelSelectorItem = (props: ModelSelectorItemProps) => (
  <CommandItem {...props} />
);

export type ModelSelectorShortcutProps = ComponentProps<typeof CommandShortcut>;

export const ModelSelectorShortcut = (props: ModelSelectorShortcutProps) => (
  <CommandShortcut {...props} />
);

export type ModelSelectorSeparatorProps = ComponentProps<
  typeof CommandSeparator
>;

export const ModelSelectorSeparator = (props: ModelSelectorSeparatorProps) => (
  <CommandSeparator {...props} />
);

export type ModelSelectorLogoProps = Omit<
  ComponentProps<"img">,
  "src" | "alt"
> & {
  provider:
    | "moonshotai-cn"
    | "lucidquery"
    | "moonshotai"
    | "zai-coding-plan"
    | "alibaba"
    | "xai"
    | "vultr"
    | "nvidia"
    | "upstage"
    | "groq"
    | "github-copilot"
    | "mistral"
    | "vercel"
    | "nebius"
    | "deepseek"
    | "alibaba-cn"
    | "google-vertex-anthropic"
    | "venice"
    | "chutes"
    | "cortecs"
    | "github-models"
    | "togetherai"
    | "azure"
    | "baseten"
    | "huggingface"
    | "opencode"
    | "fastrouter"
    | "google"
    | "google-vertex"
    | "cloudflare-workers-ai"
    | "inception"
    | "wandb"
    | "openai"
    | "zhipuai-coding-plan"
    | "perplexity"
    | "openrouter"
    | "zenmux"
    | "v0"
    | "iflowcn"
    | "synthetic"
    | "deepinfra"
    | "zhipuai"
    | "submodel"
    | "zai"
    | "inference"
    | "requesty"
    | "morph"
    | "lmstudio"
    | "anthropic"
    | "aihubmix"
    | "fireworks-ai"
    | "modelscope"
    | "llama"
    | "scaleway"
    | "amazon-bedrock"
    | "cerebras"
    // oxlint-disable-next-line typescript-eslint(ban-types) -- intentional pattern for autocomplete-friendly string union
    | (string & {});
};

export const ModelSelectorLogo = ({
  provider,
  className,
  ...props
}: ModelSelectorLogoProps) => (
  <img
    {...props}
    alt={`${provider} logo`}
    className={cn("size-3 [filter:var(--app-logo-filter,none)]", className)}
    height={12}
    src={`https://models.dev/logos/${provider}.svg`}
    width={12}
  />
);

export type ModelSelectorLogoGroupProps = ComponentProps<"div">;

export const ModelSelectorLogoGroup = ({
  className,
  ...props
}: ModelSelectorLogoGroupProps) => (
  <div
    className={cn(
      "flex shrink-0 items-center -space-x-1 [&>img]:rounded-full [&>img]:bg-background [&>img]:p-px [&>img]:ring-1 [&>img]:ring-border",
      className
    )}
    {...props}
  />
);

export type ModelSelectorNameProps = ComponentProps<"span">;

export const ModelSelectorName = ({
  className,
  ...props
}: ModelSelectorNameProps) => (
  <span className={cn("flex-1 truncate text-left", className)} {...props} />
);
