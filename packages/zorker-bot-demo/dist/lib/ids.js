let counter = 0;
export function uniqueId(prefix) {
    counter += 1;
    return `${prefix}-${Date.now().toString(36)}-${counter}`;
}
