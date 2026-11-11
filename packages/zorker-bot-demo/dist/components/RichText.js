import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { AGENT_BY_NAME } from '../data/agents';
import { RICH_TEXT_PATTERN } from '../lib/rich-text';
import { AgentAvatar } from './AgentAvatar';
export function RichText({ content, assetBase, className }) {
    const parts = content.split(RICH_TEXT_PATTERN);
    return (_jsx("span", { className: className, children: parts.map((part, index) => {
            var _a;
            if (part.startsWith('**') && part.endsWith('**')) {
                return _jsx("strong", { children: part.slice(2, -2) }, index);
            }
            if (part.startsWith('@[') && part.endsWith(']')) {
                const name = part.slice(2, -1);
                const agent = AGENT_BY_NAME[name];
                return (_jsxs("span", { className: "zbd-mention", style: { color: (_a = agent === null || agent === void 0 ? void 0 : agent.ink) !== null && _a !== void 0 ? _a : 'var(--zbd-current-accent)' }, children: [agent ? _jsx(AgentAvatar, { agent: agent, assetBase: assetBase, size: 14 }) : null, name] }, index));
            }
            return _jsx("span", { children: part }, index);
        }) }));
}
