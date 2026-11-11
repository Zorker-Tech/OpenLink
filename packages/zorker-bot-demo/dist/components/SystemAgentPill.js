import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { AGENT_BY_NAME } from '../data/agents';
import { AgentAvatar } from './AgentAvatar';
export function SystemAgentPill({ name, assetBase, }) {
    const agent = AGENT_BY_NAME[name];
    if (!agent)
        return _jsx("span", { className: "zbd-system-agent", children: name });
    return (_jsxs("span", { className: "zbd-system-agent", children: [_jsx(AgentAvatar, { agent: agent, assetBase: assetBase, size: 12 }), _jsx("span", { children: name })] }));
}
