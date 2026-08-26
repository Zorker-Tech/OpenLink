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
import AnthropicMono from "@lobehub/icons/es/Anthropic/components/Mono";
import CohereMono from "@lobehub/icons/es/Cohere/components/Mono";
import DeepSeekMono from "@lobehub/icons/es/DeepSeek/components/Mono";
import GeminiMono from "@lobehub/icons/es/Gemini/components/Mono";
import GoogleMono from "@lobehub/icons/es/Google/components/Mono";
import MetaMono from "@lobehub/icons/es/Meta/components/Mono";
import MicrosoftMono from "@lobehub/icons/es/Microsoft/components/Mono";
import MinimaxMono from "@lobehub/icons/es/Minimax/components/Mono";
import MistralMono from "@lobehub/icons/es/Mistral/components/Mono";
import MoonshotMono from "@lobehub/icons/es/Moonshot/components/Mono";
import NvidiaMono from "@lobehub/icons/es/Nvidia/components/Mono";
import OpenAIMono from "@lobehub/icons/es/OpenAI/components/Mono";
import QwenMono from "@lobehub/icons/es/Qwen/components/Mono";
import XAIMono from "@lobehub/icons/es/XAI/components/Mono";
import ZhipuMono from "@lobehub/icons/es/Zhipu/components/Mono";
import { cn } from "@/lib/utils";
import type { ComponentProps, ComponentType, CSSProperties, ReactNode } from "react";

/** LobeHub Mono icons keyed by the brand slug resolved from a model name. */
const MODEL_LOGO_COMPONENTS: Record<string, ComponentType<{ size?: number | string; style?: CSSProperties }>> = {
  anthropic: AnthropicMono,
  cohere: CohereMono,
  deepseek: DeepSeekMono,
  gemini: GeminiMono,
  google: GoogleMono,
  meta: MetaMono,
  microsoft: MicrosoftMono,
  minimax: MinimaxMono,
  mistral: MistralMono,
  moonshot: MoonshotMono,
  nvidia: NvidiaMono,
  openai: OpenAIMono,
  qwen: QwenMono,
  xai: XAIMono,
  zhipu: ZhipuMono,
};

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
  style,
  ...props
}: ModelSelectorLogoProps) => {
  // Render model logos from the LobeHub catalogue when the slug maps to a
  // known brand; otherwise fall back to the models.dev image so nothing is
  // left without a mark.
  const LobeIcon = MODEL_LOGO_COMPONENTS[provider];
  if (LobeIcon) {
    return (
      <span
        className={cn("inline-flex shrink-0 items-center justify-center [filter:var(--app-logo-filter,none)]", className)}
        style={style}
      >
        <LobeIcon size="100%" />
      </span>
    );
  }

  const src = provider === "hydite" || provider === "hydite-vtslx-ao"
    ? "/openlink/providers/hydite.svg"
    : `https://models.dev/logos/${provider}.svg`;

  return (
    <img
      {...props}
      alt={`${provider} logo`}
      className={cn("size-3 [filter:var(--app-logo-filter,none)]", className)}
      height={12}
      src={src}
      style={style}
      width={12}
    />
  );
};

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
