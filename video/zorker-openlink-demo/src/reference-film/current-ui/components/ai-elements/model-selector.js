import {staticFile as filmStaticFile} from 'remotion';
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, CommandShortcut, } from "../ui/command.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger, } from "../ui/dropdown-menu.js";
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
import { Network as NetworkIcon } from "lucide-react";
import { cn } from "../../lib/utils.js";
/** LobeHub Mono icons keyed by the brand slug resolved from a model name. */
const MODEL_LOGO_COMPONENTS = {
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
    v0: NetworkIcon,
    vercel: NetworkIcon,
    xai: XAIMono,
    zhipu: ZhipuMono,
};
export const ModelSelector = (props) => (_jsx(DropdownMenu, { ...props }));
export const ModelSelectorTrigger = (props) => (_jsx(DropdownMenuTrigger, { ...props }));
export const ModelSelectorContent = ({ className, children, title = "Model Selector", ...props }) => (_jsxs(DropdownMenuContent, { "aria-describedby": undefined, className: cn("z-50 rounded-xl border border-[var(--app-border)] bg-[var(--app-elevated)] p-1 text-[var(--app-foreground)] shadow-[0_12px_36px_var(--app-shadow)]", className), ...props, children: [_jsx("span", { className: "sr-only", children: title }), _jsx(Command, { className: "**:data-[slot=command-input-wrapper]:h-auto", children: children })] }));
export const ModelSelectorDialog = (props) => (_jsx(CommandDialog, { ...props }));
export const ModelSelectorInput = ({ className, ...props }) => (_jsx(CommandInput, { className: cn("h-auto py-3.5", className), ...props }));
export const ModelSelectorList = (props) => (_jsx(CommandList, { ...props }));
export const ModelSelectorEmpty = (props) => (_jsx(CommandEmpty, { ...props }));
export const ModelSelectorGroup = (props) => (_jsx(CommandGroup, { ...props }));
export const ModelSelectorItem = (props) => (_jsx(CommandItem, { ...props }));
export const ModelSelectorShortcut = (props) => (_jsx(CommandShortcut, { ...props }));
export const ModelSelectorSeparator = (props) => (_jsx(CommandSeparator, { ...props }));
export const ModelSelectorLogo = ({ provider, className, style, ...props }) => {
    // Render model logos from the LobeHub catalogue when the slug maps to a
    // known brand; otherwise fall back to the models.dev image so nothing is
    // left without a mark.
    const LobeIcon = MODEL_LOGO_COMPONENTS[provider];
    if (LobeIcon) {
        return (_jsx("span", { className: cn("inline-flex shrink-0 items-center justify-center [filter:var(--app-logo-filter,none)]", className), style: style, children: _jsx(LobeIcon, { size: "100%" }) }));
    }
    const src = provider === "hydite" || provider === "hydite-vtslx-ao"
        ? filmStaticFile("openlink/providers/hydite.svg")
        : `https://models.dev/logos/${provider}.svg`;
    return (_jsx("img", { ...props, alt: provider === "v0" || provider === "vercel" ? "Model provider logo" : `${provider} logo`, className: cn("size-3 [filter:var(--app-logo-filter,none)]", className), height: 12, src: src, style: style, width: 12 }));
};
export const ModelSelectorLogoGroup = ({ className, ...props }) => (_jsx("div", { className: cn("flex shrink-0 items-center -space-x-1 [&>img]:rounded-full [&>img]:bg-background [&>img]:p-px [&>img]:ring-1 [&>img]:ring-border", className), ...props }));
export const ModelSelectorName = ({ className, ...props }) => (_jsx("span", { className: cn("flex-1 truncate text-left", className), ...props }));
