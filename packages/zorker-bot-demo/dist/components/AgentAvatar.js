import { jsx as _jsx } from "react/jsx-runtime";
import { AGENTS } from '../data/agents';
export function AgentAvatar({ agent, assetBase, size = 32, className, }) {
    if (agent.group) {
        const members = agent.group
            .map((id) => AGENTS.find((item) => item.id === id))
            .filter((item) => Boolean(item));
        return (_jsx("span", { "aria-hidden": "true", className: `zbd-agent-avatar zbd-agent-avatar-group ${className !== null && className !== void 0 ? className : ''}`, style: { width: size, height: size }, children: members.map((member, index) => (_jsx("span", { className: "zbd-agent-avatar-group-item", style: {
                    width: size * 0.56,
                    height: size * 0.56,
                    left: index === 0 ? 0 : index === 1 ? size * 0.44 : size * 0.22,
                    top: index === 0 ? 0 : index === 1 ? 0 : size * 0.44,
                    zIndex: index === 2 ? 3 : index === 1 ? 2 : 1,
                    background: member.ink,
                }, children: _jsx("img", { alt: "", draggable: false, src: `${assetBase}/avatars/${member.avatar}.svg` }) }, member.id))) }));
    }
    return (_jsx("span", { "aria-hidden": "true", className: `zbd-agent-avatar ${className !== null && className !== void 0 ? className : ''}`, style: { width: size, height: size, ['--agent-ink']: agent.ink }, children: _jsx("img", { alt: "", draggable: false, src: `${assetBase}/avatars/${agent.avatar}.svg` }) }));
}
