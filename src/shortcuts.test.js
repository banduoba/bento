import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ENTER_OPEN,
  ENTER_RENAME,
  listIndexAfterKey,
  normalizeEnterAction,
  otherPaneIndex,
  pageStride,
  paneIndexAfterKey,
  resolveListKey,
  resolvePaneKey,
} from './shortcuts.js'

const key = (props) => resolveListKey({ altKey: false, ctrlKey: false, shiftKey: false, metaKey: false, ...props }, props.enterAction)

test('enter action normalizes to rename unless explicitly open', () => {
  assert.equal(normalizeEnterAction(undefined), ENTER_RENAME)
  assert.equal(normalizeEnterAction('nope'), ENTER_RENAME)
  assert.equal(normalizeEnterAction(ENTER_OPEN), ENTER_OPEN)
})

test('Enter follows the preference; F2 always renames; ⌘↓ always opens', () => {
  assert.equal(key({ key: 'Enter', enterAction: ENTER_RENAME }), 'rename')
  assert.equal(key({ key: 'Enter', enterAction: ENTER_OPEN }), 'open')
  assert.equal(key({ key: 'Enter' }), 'rename')
  assert.equal(key({ key: 'F2', enterAction: ENTER_OPEN }), 'rename')
  assert.equal(key({ key: 'F2', enterAction: ENTER_RENAME }), 'rename')
  assert.equal(key({ key: 'ArrowDown', metaKey: true, enterAction: ENTER_RENAME }), 'open')
  assert.equal(key({ key: 'ArrowDown', metaKey: true, enterAction: ENTER_OPEN }), 'open')
  assert.equal(key({ key: 'ArrowUp', metaKey: true }), 'parent')
})

test('arrow, home, end, and page keys move the list', () => {
  assert.equal(key({ key: 'ArrowDown' }), 'next')
  assert.equal(key({ key: 'ArrowUp' }), 'prev')
  assert.equal(key({ key: 'ArrowRight' }), 'enterDir')
  assert.equal(key({ key: 'ArrowLeft' }), 'parent')
  assert.equal(key({ key: 'Home' }), 'first')
  assert.equal(key({ key: 'End' }), 'last')
  assert.equal(key({ key: 'PageDown' }), 'pageDown')
  assert.equal(key({ key: 'PageUp' }), 'pageUp')
})

test('modified keys are left alone', () => {
  for (const extra of [{ shiftKey: true }, { altKey: true }, { ctrlKey: true }, { metaKey: true }]) {
    assert.equal(key({ key: 'Enter', ...extra }), null)
    assert.equal(key({ key: 'Home', ...extra }), null)
    assert.equal(key({ key: 'ArrowDown', ...extra }), extra.metaKey ? 'open' : null)
  }
  assert.equal(key({ key: 'ArrowLeft', metaKey: true }), null)
  assert.equal(key({ key: 'ArrowRight', metaKey: true }), null)
})

const paneKey = (props) => resolvePaneKey({ altKey: false, ctrlKey: false, shiftKey: false, metaKey: false, ...props })

test('Tab and Shift+Tab switch panes; F5 copies and F6 moves', () => {
  assert.equal(paneKey({ key: 'Tab' }), 'focusNext')
  assert.equal(paneKey({ key: 'Tab', shiftKey: true }), 'focusPrev')
  assert.equal(paneKey({ key: 'F5' }), 'copyToOther')
  assert.equal(paneKey({ key: 'F6' }), 'moveToOther')
})

test('pane shortcuts ignore modifiers that already mean something else', () => {
  for (const extra of [{ metaKey: true }, { altKey: true }, { ctrlKey: true }]) {
    assert.equal(paneKey({ key: 'Tab', ...extra }), null)
    assert.equal(paneKey({ key: 'F5', ...extra }), null)
    assert.equal(paneKey({ key: 'F6', ...extra }), null)
  }
  assert.equal(paneKey({ key: 'F5', shiftKey: true }), null)
  assert.equal(paneKey({ key: 'F6', shiftKey: true }), null)
  assert.equal(paneKey({ key: 'Enter' }), null)
  assert.equal(paneKey(null), null)
})

test('Tab cycles visible panes and does nothing when only one is showing', () => {
  assert.equal(paneIndexAfterKey('focusNext', 0, 1), -1)
  assert.equal(paneIndexAfterKey('focusPrev', 0, 1), -1)
  assert.equal(paneIndexAfterKey('focusNext', 0, 2), 1)
  assert.equal(paneIndexAfterKey('focusNext', 1, 2), 0)
  assert.equal(paneIndexAfterKey('focusPrev', 0, 2), 1)
  assert.equal(paneIndexAfterKey('focusPrev', 1, 2), 0)
  assert.equal(paneIndexAfterKey('focusNext', 3, 4), 0)
  assert.equal(paneIndexAfterKey('focusPrev', 0, 4), 3)
  assert.equal(paneIndexAfterKey('copyToOther', 0, 2), -1)
  assert.equal(paneIndexAfterKey('focusNext', -1, 2), -1)
  assert.equal(paneIndexAfterKey('focusNext', 0, 0), -1)
})

test('F5/F6 target the other pane, or the pane just left when there are more than two', () => {
  assert.equal(otherPaneIndex(0, 1), -1)
  assert.equal(otherPaneIndex(0, 2), 1)
  assert.equal(otherPaneIndex(1, 2, 1), 0)
  assert.equal(otherPaneIndex(2, 4, 0), 0)
  assert.equal(otherPaneIndex(0, 4, 3), 3)
  assert.equal(otherPaneIndex(0, 4, 0), 1)
  assert.equal(otherPaneIndex(0, 4, 9), 1)
  assert.equal(otherPaneIndex(0, 4, null), 1)
  assert.equal(otherPaneIndex(4, 4, 1), -1)
})

test('list index clamps and pages with overlap', () => {
  assert.equal(listIndexAfterKey('next', -1, 5, 3), 0)
  assert.equal(listIndexAfterKey('prev', -1, 5, 3), 4)
  assert.equal(listIndexAfterKey('first', 3, 5, 3), 0)
  assert.equal(listIndexAfterKey('last', 1, 5, 3), 4)
  assert.equal(listIndexAfterKey('next', 4, 5, 3), 4)
  assert.equal(listIndexAfterKey('prev', 0, 5, 3), 0)
  assert.equal(listIndexAfterKey('pageDown', 0, 20, 4), 4)
  assert.equal(listIndexAfterKey('pageDown', 18, 20, 4), 19)
  assert.equal(listIndexAfterKey('pageUp', 10, 20, 4), 6)
  assert.equal(listIndexAfterKey('pageUp', 2, 20, 4), 0)
  assert.equal(listIndexAfterKey('pageDown', -1, 0, 4), -1)
  assert.equal(pageStride(30 * 8), 7)
  assert.equal(pageStride(0), 9)
})
