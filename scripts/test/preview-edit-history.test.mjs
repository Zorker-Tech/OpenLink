import assert from 'node:assert/strict'
import test from 'node:test'
import {
  beginPreviewEditTransaction,
  commitPreviewEditSnapshot,
  createPreviewEditHistory,
  finishPreviewEditTransaction,
  previewStyleEditKey,
  redoPreviewEditHistory,
  undoPreviewEditHistory,
} from '../../lib/preview-edit-history.mjs'

test('coalesces keystrokes in one focused edit into a single undo step', () => {
  const before = [{ key: 'color', after: 'black' }]
  let history = { ...createPreviewEditHistory(), pending: before }
  history = beginPreviewEditTransaction(history, 'content:heading')
  history = commitPreviewEditSnapshot(history, [{ key: 'content', after: 'H' }], 'content:heading')
  history = commitPreviewEditSnapshot(history, [{ key: 'content', after: 'He' }], 'content:heading')
  history = commitPreviewEditSnapshot(history, [{ key: 'content', after: 'Hello' }], 'content:heading')

  assert.equal(history.undo.length, 1)
  assert.deepEqual(history.undo[0], before)
  assert.deepEqual(history.pending, [{ key: 'content', after: 'Hello' }])
})

test('separate focused controls create separate undo checkpoints and redo restores them', () => {
  let history = createPreviewEditHistory()
  history = beginPreviewEditTransaction(history, 'style:heading:color')
  history = commitPreviewEditSnapshot(history, [{ key: 'color', after: 'red' }], 'style:heading:color')
  history = finishPreviewEditTransaction(history, 'style:heading:color')
  history = beginPreviewEditTransaction(history, 'style:heading:font-size')
  history = commitPreviewEditSnapshot(history, [
    { key: 'color', after: 'red' },
    { key: 'font-size', after: '20px' },
  ], 'style:heading:font-size')

  assert.equal(history.undo.length, 2)
  history = undoPreviewEditHistory(history)
  assert.deepEqual(history.pending, [{ key: 'color', after: 'red' }])
  history = redoPreviewEditHistory(history)
  assert.deepEqual(history.pending, [
    { key: 'color', after: 'red' },
    { key: 'font-size', after: '20px' },
  ])
})

test('new edits invalidate redo history and undo checkpoints stay bounded', () => {
  let history = createPreviewEditHistory()
  for (let index = 0; index < 35; index += 1) {
    history = commitPreviewEditSnapshot(history, [{ key: 'value', after: String(index) }])
  }
  assert.equal(history.undo.length, 30)
  history = undoPreviewEditHistory(history)
  assert.equal(history.redo.length, 1)
  history = commitPreviewEditSnapshot(history, [{ key: 'value', after: 'new branch' }])
  assert.equal(history.redo.length, 0)
})

test('style edits use collision-free keys scoped to element and property', () => {
  assert.notEqual(previewStyleEditKey('element-a', 'color'), previewStyleEditKey('element-b', 'color'))
  assert.notEqual(previewStyleEditKey('element-a', 'color'), previewStyleEditKey('element-a', 'font-size'))
  assert.notEqual(previewStyleEditKey('a:b', 'c'), previewStyleEditKey('a', 'b:c'))
})

test('unchanged input does not add an undo checkpoint or clear redo', () => {
  let history = createPreviewEditHistory()
  history = commitPreviewEditSnapshot(history, [{ key: 'value', after: 'changed' }])
  history = undoPreviewEditHistory(history)
  const unchanged = commitPreviewEditSnapshot(history, [], 'value')

  assert.equal(unchanged, history)
  assert.equal(unchanged.undo.length, 0)
  assert.equal(unchanged.redo.length, 1)
})
