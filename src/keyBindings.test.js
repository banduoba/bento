import test from 'node:test'
import assert from 'node:assert/strict'
import { bindingFromEvent, validateBindings, normalizeBindings, effectiveBindings, resolveShortcut, shortcutLabel, shortcutPreset, createShortcutBackup, parseShortcutBackup, viewAccelerators } from './keyBindings.js'

test('default commands retain aliases and distinguish name, path and native file copy', () => {
 assert.equal(resolveShortcut({key:'C',code:'KeyC',metaKey:true,shiftKey:true},{}),'edit-copy-names')
 assert.equal(resolveShortcut({key:'ç',code:'KeyC',metaKey:true,altKey:true},{}),'edit-copy-paths')
 assert.equal(resolveShortcut({key:'c',code:'KeyC',metaKey:true},{}),null)
 assert.equal(resolveShortcut({key:'G',metaKey:true,shiftKey:true},{}),'go-address')
 assert.equal(resolveShortcut({key:'2',metaKey:true},{}),'view-list')
})
test('an override replaces every default alias and null disables only that command', () => {
 const map=validateBindings({'go-address':'Meta+Shift+KeyP','edit-copy-names':null})
 assert.equal(resolveShortcut({key:'l',metaKey:true},map),null)
 assert.equal(resolveShortcut({key:'G',metaKey:true,shiftKey:true},map),null)
 assert.equal(resolveShortcut({key:'P',metaKey:true,shiftKey:true},map),'go-address')
 assert.equal(shortcutLabel(map,'edit-copy-names'),'未设置')
 assert.equal(shortcutLabel(map,'go-address'),'⇧⌘P')
})
test('recording rejects composition, dead keys, modifiers and unsupported physical keys', () => {
 for(const e of [{key:'Process',code:'KeyA',isComposing:true},{key:'Dead',code:'KeyE',altKey:true},{key:'a',code:'KeyA',keyCode:229},{key:'Shift',code:'ShiftLeft'},{key:'音',code:'Unidentified'}])assert.equal(bindingFromEvent(e),null)
 assert.equal(bindingFromEvent({key:'†',code:'KeyT',metaKey:true,altKey:true}),'Meta+Alt+KeyT')
})
test('conflicts with other defaults or immutable editor/system/navigation keys are rejected atomically', () => {
 for(const map of [{'file-rename':'Meta+KeyL'},{'file-trash':'Meta+KeyC'},{'file-rename':'Control+Tab'},{'file-rename':'KeyR'},{'file-rename':'F5'},{'file-rename':'Meta+KeyQ'},{'file-rename':'Meta+Comma'},{'file-rename':'ArrowDown'},{'file-rename':'Space'},{'bogus':'Meta+KeyU'},{'file-rename':'Alt+Meta+KeyU'}])assert.throws(()=>validateBindings(map))
 assert.deepEqual(validateBindings({'go-address':null,'file-rename':'Meta+KeyL'}),{'go-address':null,'file-rename':'Meta+KeyL'})
 assert.deepEqual(normalizeBindings({'file-rename':'Meta+KeyC'}),{})
})
test('Commander is explicit, reversible and never changes native clipboard commands', () => {
 const map=validateBindings(shortcutPreset('commander'))
 assert.equal(resolveShortcut({key:'F7'},map),'file-new-folder')
 assert.equal(resolveShortcut({key:'F8'},map),'file-trash')
 assert.equal(resolveShortcut({key:'F3'},map),'quick-look')
 assert.equal(resolveShortcut({key:'F7',altKey:true},map),'search-open')
 assert.equal(resolveShortcut({key:'v',metaKey:true},map),null)
 assert.deepEqual(shortcutPreset('finder'),{})
})
test('shortcut backup round trip is detached and invalid imports never return partial settings', () => {
 const value={'file-rename':'Meta+Shift+KeyR'},doc=createShortcutBackup(value)
 value['file-rename']='F4'
 assert.deepEqual(parseShortcutBackup(JSON.stringify(doc)),{'file-rename':'Meta+Shift+KeyR'})
 for(const text of ['{}','{',JSON.stringify({...doc,version:2}),JSON.stringify({...doc,extra:1}),JSON.stringify({...doc,bindings:{'file-rename':'Meta+KeyV'}}),' '.repeat(65537)])assert.throws(()=>parseShortcutBackup(text))
})
test('native view accelerators follow overrides and removal without keeping old bindings', () => {
 assert.deepEqual(viewAccelerators({'view-list':'Meta+Shift+KeyL','view-icons':null}),{'view-icons':null,'view-list':'Super+Shift+L','view-columns':'Super+3'})
 assert.deepEqual(effectiveBindings({})['go-address'],['Meta+KeyL','Meta+Shift+KeyG'])
})
