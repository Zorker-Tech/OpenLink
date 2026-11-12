import { jsx as _jsx } from "react/jsx-runtime";
import { AgentAvatar as LiveAgentAvatar } from '@zorker/avatar';
import { AGENTS } from '../data/agents';
export function AgentAvatar({ agent, assetBase, size = 32, className, }) {
    if (agent.group) {
        const members = agent.group
            .map((id) => AGENTS.find((item) => item.id === id))
            .filter((item) => Boolean(item));
        return (_jsx("span", { "aria-hidden": "true", className: `zbd-agent-avatar zbd-agent-avatar-group ${className ?? ''}`, style: { width: size, height: size }, children: members.map((member, index) => (_jsx("span", { className: "zbd-agent-avatar-group-item", style: {
                    width: size * 0.56,
                    height: size * 0.56,
                    left: index === 0 ? 0 : index === 1 ? size * 0.44 : size * 0.22,
                    top: index === 0 ? 0 : index === 1 ? 0 : size * 0.44,
                    zIndex: index === 2 ? 3 : index === 1 ? 2 : 1,
                    background: member.ink,
                }, children: _jsx("img", { alt: "", draggable: false, src: `${assetBase}/avatars/${member.avatar}.svg` }) }, member.id))) }));
    }
    if (agent.avatarShape && agent.avatarColor) {
        return (_jsx("span", { "aria-hidden": "true", className: `zbd-agent-avatar zbd-agent-avatar-live ${className ?? ''}`, style: { width: size, height: size, ['--agent-ink']: agent.ink }, children: _jsx(LiveAgentAvatar, { autoBlink: true, className: "zbd-agent-avatar-engine", color: agent.avatarColor, effects: false, glow: 0, idleMotion: true, interactive: false, renderer: "complete", ring: false, shadow: false, shape: agent.avatarShape, size: size, state: "idle", theme: "auto" }) }));
    }
    return (_jsx("span", { "aria-hidden": "true", className: `zbd-agent-avatar ${className ?? ''}`, style: { width: size, height: size, ['--agent-ink']: agent.ink }, children: _jsx("img", { alt: "", draggable: false, src: agent.avatarUrl ?? `${assetBase}/avatars/${agent.avatar}.svg` }) }));
}
