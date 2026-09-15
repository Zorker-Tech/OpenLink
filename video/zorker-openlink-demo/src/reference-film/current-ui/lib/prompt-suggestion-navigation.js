export function enabledSuggestionIndex(items, requestedIndex) {
    if (items[requestedIndex] && !items[requestedIndex].disabled)
        return requestedIndex;
    return items.findIndex((item) => !item.disabled);
}
export function nextEnabledSuggestionIndex(items, currentIndex, direction) {
    if (!items.length)
        return -1;
    for (let distance = 1; distance <= items.length; distance += 1) {
        const index = (currentIndex + direction * distance + items.length) % items.length;
        if (!items[index]?.disabled)
            return index;
    }
    return -1;
}
