const BOX_DRAWING_CHARS = new Set([
  "─", "━", "═", "-", "_",
  "│", "┃", "║", "|",
  "┌", "┐", "└", "┘", "╔", "╗", "╚", "╝", "┏", "┓", "┗", "┛", "╓", "╖", "╙", "╜",
  "├", "┤", "┬", "┴", "┼", "╟", "╢", "╤", "╧", "╫", "╠", "╣", "╦", "╩", "╬", "╞", "╡", "╥", "╨", "╪",
  "+",
])

/** A line made mostly from border marks is layout, not a model repeating itself. */
export function isBoxBorderLine(line: string): boolean {
  let borderMarks = 0
  let visibleCharacters = 0
  for (const character of line) {
    if (character !== " " && character !== "\t") visibleCharacters++
    if (BOX_DRAWING_CHARS.has(character)) borderMarks++
  }
  return visibleCharacters > 0 && borderMarks / visibleCharacters >= 0.8
}

/** Fence markers change parsing mode only when an odd number appears on a line. */
export function nextCodeFenceState(line: string, insideFence: boolean): boolean {
  if (line.length === 0) return insideFence
  const markers = line.match(/```+(?!`)/g)
  return markers !== null && markers.length % 2 === 1 ? !insideFence : insideFence
}
