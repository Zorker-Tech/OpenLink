export function messageDelay(content) {
    const words = content.split(' ').length;
    return Math.min(1900 + 22 * words, 3000);
}
