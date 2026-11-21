export declare const QUICK_REACTIONS: readonly ['🫠', '👍', '😂', '👎', '❤️'];
export type EmojiPickerProps = {
    anchor: HTMLElement | null;
    onPick: (emoji: string) => void;
    onClose: () => void;
};
/**
 * A reaction picker with a search field, quick reactions, grouped sections and
 * a category rail. It is portalled to the body so the transcript's scroll
 * container cannot clip it.
 */
export declare function EmojiPicker({ anchor, onPick, onClose }: EmojiPickerProps): import("react").ReactPortal;
//# sourceMappingURL=EmojiPicker.d.ts.map