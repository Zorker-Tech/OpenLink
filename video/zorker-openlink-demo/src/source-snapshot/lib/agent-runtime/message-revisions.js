/** Keep the append-only audit journal while presenting only the active branch. */
export function projectMessageRevisions(events) {
    const active = [];
    for (const event of events) {
        if (event.type === 'message.user' && event.replacesMessageId) {
            const index = active.findIndex((item) => item.type === 'message.user' && item.messageId === event.replacesMessageId);
            if (index >= 0)
                active.splice(index);
        }
        active.push(event);
    }
    return active;
}
