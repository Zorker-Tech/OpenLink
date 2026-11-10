/** Split a character budget among messages using a max-min fair allocation. */
export function maxMinCharacterShares(sizes: readonly number[], totalBudget: number): number[] {
  const shares = new Array<number>(sizes.length).fill(0);
  const shortestFirst = sizes
    .map((size, index) => ({ size, index }))
    .sort((left, right) => left.size - right.size);
  let remaining = totalBudget;

  for (let rank = 0; rank < shortestFirst.length; rank += 1) {
    const current = shortestFirst[rank]!;
    const equalShare = Math.floor(remaining / (shortestFirst.length - rank));
    const assigned = Math.min(current.size, equalShare);
    shares[current.index] = assigned;
    remaining -= assigned;
  }
  return shares;
}
