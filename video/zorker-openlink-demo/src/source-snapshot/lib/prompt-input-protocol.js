/**
 * Codex's composer uses `$name` for a native Skill input and `@name` for a
 * native Plugin mention.  Keep these tokens in one place so menus and the
 * inline picker cannot silently fall back to prose prompts.
 */
export function codexSkillToken(name) {
    return `$${name.trim()} `;
}
export function codexPluginMentionName(pluginName, displayName) {
    const pluginSegments = [...pluginName.matchAll(/([^_-]+)([_-]?)/g)]
        .map((match) => ({ value: match[1] ?? '', separator: match[2] ?? '' }));
    const displaySegments = displayName.split(/[^A-Za-z0-9]+/).filter(Boolean);
    if (pluginSegments.length === displaySegments.length && pluginSegments.every((segment, index) => segment.value.toLocaleLowerCase() === displaySegments[index]?.toLocaleLowerCase())) {
        return pluginSegments.map((segment, index) => `${displaySegments[index]}${segment.separator}`).join('');
    }
    let capitalizeNext = true;
    return [...pluginName].map((character) => {
        if (character === '-' || character === '_') {
            capitalizeNext = true;
            return character;
        }
        const value = capitalizeNext && /[A-Za-z]/.test(character) ? character.toLocaleUpperCase() : character;
        capitalizeNext = false;
        return value;
    }).join('');
}
export function codexPluginToken(pluginName, displayName) {
    return `@${codexPluginMentionName(pluginName.trim(), displayName.trim())} `;
}
/** Pi exposes loaded Skills as native `/skill:<name>` commands. */
export function piSkillToken(name) {
    return `/skill:${name.trim()} `;
}
export function promptTriggerAt(value, cursor, options = {}) {
    const before = value.slice(0, Math.max(0, cursor));
    const commandArgument = (options.lineStartOnly ? /(^|\n)[ \t]*\/([\w:-]+)[ \t]+([^\n]*)$/ : /(^|\s)\/([\w:-]+)[ \t]+([^\n]*)$/).exec(before);
    if (commandArgument && ['model', 'skills', 'plugins', 'apps', 'mcp', 'permissions'].includes(commandArgument[2])) {
        const query = commandArgument[3] ?? '';
        return { kind: 'command', command: commandArgument[2], query, start: cursor - query.length, end: cursor };
    }
    const command = (options.lineStartOnly ? /(^|\n)[ \t]*\/([\w:-]*)$/ : /(^|\s)\/([\w:-]*)$/).exec(before);
    if (command) {
        const slash = before.lastIndexOf('/');
        return { kind: 'command', query: command[2] ?? '', start: slash, end: cursor };
    }
    const skill = /(^|\s)\$([^\s$]*)$/.exec(before);
    if (skill) {
        const dollar = before.lastIndexOf('$');
        return { kind: 'skill', query: skill[2] ?? '', start: dollar, end: cursor };
    }
    const mention = /(^|\s)@([^\s@]*)$/.exec(before);
    if (mention) {
        const at = before.lastIndexOf('@');
        return { kind: 'mention', query: mention[2] ?? '', start: at, end: cursor };
    }
    return null;
}
export function replacePromptTrigger(value, trigger, replacement) {
    const next = `${value.slice(0, trigger.start)}${replacement}${value.slice(trigger.end)}`;
    return { value: next, cursor: trigger.start + replacement.length };
}
