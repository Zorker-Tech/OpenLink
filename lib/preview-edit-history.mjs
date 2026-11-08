/**
 * @template T
 * @typedef {object} PreviewEditHistory
 * @property {T[]} pending
 * @property {T[][]} undo
 * @property {T[][]} redo
 * @property {{ key: string, before: T[], recorded: boolean } | null} transaction
 */

/** @template T @returns {PreviewEditHistory<T>} */
export function createPreviewEditHistory() {
  return { pending: [], undo: [], redo: [], transaction: null }
}

/** @template T @param {PreviewEditHistory<T>} state @param {string} key */
export function beginPreviewEditTransaction(state, key) {
  return {
    ...state,
    transaction: { key, before: [...state.pending], recorded: false },
  }
}

/**
 * @template T
 * @param {PreviewEditHistory<T>} state
 * @param {T[]} next
 * @param {string | undefined} transactionKey
 * @returns {PreviewEditHistory<T>}
 */
export function commitPreviewEditSnapshot(state, next, transactionKey) {
  const sameSnapshot = state.pending.length === next.length
    && state.pending.every((edit, index) => {
      const candidate = next[index]
      return candidate && Object.keys(edit).length === Object.keys(candidate).length
        && Object.keys(edit).every((key) => edit[key] === candidate[key])
    })
  if (sameSnapshot) return state

  const transaction = transactionKey && state.transaction?.key === transactionKey
    ? state.transaction
    : null
  const shouldRecord = !transaction || !transaction.recorded

  return {
    pending: [...next],
    undo: shouldRecord
      ? [...state.undo.slice(-29), [...(transaction?.before ?? state.pending)]]
      : state.undo,
    redo: [],
    transaction: transaction ? { ...transaction, recorded: true } : state.transaction,
  }
}

/** @template T @param {PreviewEditHistory<T>} state @param {string} key */
export function finishPreviewEditTransaction(state, key) {
  return state.transaction?.key === key ? { ...state, transaction: null } : state
}

/** @template T @param {PreviewEditHistory<T>} state @returns {PreviewEditHistory<T>} */
export function undoPreviewEditHistory(state) {
  const previous = state.undo.at(-1)
  if (!previous) return state
  return {
    pending: previous,
    undo: state.undo.slice(0, -1),
    redo: [...state.redo, state.pending],
    transaction: null,
  }
}

/** @template T @param {PreviewEditHistory<T>} state @returns {PreviewEditHistory<T>} */
export function redoPreviewEditHistory(state) {
  const next = state.redo.at(-1)
  if (!next) return state
  return {
    pending: next,
    undo: [...state.undo.slice(-29), state.pending],
    redo: state.redo.slice(0, -1),
    transaction: null,
  }
}

/** @param {string} elementRef @param {string} property */
export function previewStyleEditKey(elementRef, property) {
  return `style:${JSON.stringify([elementRef, property])}`
}
