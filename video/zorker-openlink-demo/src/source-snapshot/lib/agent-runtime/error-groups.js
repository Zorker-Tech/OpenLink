export function agentErrorTitle(message) {
    if (/reconnecting/i.test(message))
        return 'Reconnecting…';
    if (/401|unauthorized|invalid api key/i.test(message))
        return 'Agent 鉴权失败';
    if (/cancel(?:led|ed)/i.test(message))
        return 'Agent 请求已取消';
    if (/timeout|timed out|stopped emitting/i.test(message))
        return 'Agent 响应超时';
    if (/worker.*ended|worker.*exit/i.test(message))
        return 'Agent Worker 已退出';
    return 'Agent 运行错误';
}
export function groupAgentErrorRecords(records) {
    const groups = [];
    const byTitle = new Map();
    for (const record of records) {
        const title = agentErrorTitle(record.message);
        const current = byTitle.get(title);
        if (current) {
            current.messages.push(record.message);
            continue;
        }
        const group = { ...record, title, messages: [record.message] };
        byTitle.set(title, group);
        groups.push(group);
    }
    return groups;
}
