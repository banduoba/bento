// App commands only. Native file/text clipboard shortcuts remain immutable.
export const SHORTCUT_COMMANDS = [
 ['search-open','搜索文件',['Meta+KeyK','Meta+Alt+KeyF']],
 ['filter-focus','筛选当前文件夹',['Meta+KeyF']],
 ['go-address','编辑地址栏',['Meta+KeyL','Meta+Shift+KeyG']],
 ['go-back','后退',['Meta+BracketLeft']], ['go-forward','前进',['Meta+BracketRight']],
 ['go-parent','上级目录',['Meta+ArrowUp']], ['file-open','打开所选项目',['Meta+ArrowDown','Meta+KeyO']],
 ['edit-copy-paths','复制路径',['Meta+Alt+KeyC']], ['edit-copy-names','复制名称',['Meta+Shift+KeyC']],
 ['view-refresh','刷新当前窗格',['Meta+KeyR']], ['file-new-tab','新建标签',['Meta+KeyT']],
 ['file-close-tab','关闭标签',['Meta+KeyW']], ['file-new-folder','新建文件夹',['Meta+Shift+KeyN']],
 ['file-rename','重命名',['F2']], ['file-duplicate','拷贝副本',['Meta+KeyD']],
 ['file-trash','移到废纸篓',['Meta+Backspace']], ['quick-look','快速查看',['Space']],
 ['view-icons','图标视图',['Meta+Digit1']], ['view-list','列表视图',['Meta+Digit2']],
 ['view-columns','分栏视图',['Meta+Digit3']], ['view-show-hidden','显示隐藏文件',['Meta+Shift+Period']],
 ['view-sidebar','显示侧边栏',['Meta+Alt+KeyS']], ['window-pin','窗口置顶',['Meta+Alt+KeyT']],
].map(([id,label,keys])=>({id,label,keys}))
const ids = new Set(SHORTCUT_COMMANDS.map(c=>c.id))
const modifiers = ['Meta','Control','Alt','Shift']
const keyCode = /^(Key[A-Z]|Digit[0-9]|F(?:[1-9]|1[0-9]|20)|Arrow(?:Up|Down|Left|Right)|Space|Tab|Enter|Escape|Backspace|Delete|Home|End|PageUp|PageDown|BracketLeft|BracketRight|Comma|Period|Slash|Backslash|Semicolon|Quote|Minus|Equal|Backquote)$/
const plain = value => value && typeof value==='object' && !Array.isArray(value)
const reserved = new Set([
 'Meta+KeyC','Meta+KeyX','Meta+KeyV','Meta+KeyZ','Meta+Shift+KeyZ','Meta+KeyA',
 'Meta+Comma','Meta+KeyQ','Meta+KeyH','Meta+Alt+KeyH','Meta+KeyM','Meta+Alt+KeyM',
 'Meta+Alt+Escape','Meta+Alt+Shift+Escape','Meta+Backquote','Meta+Shift+Backquote',
 'Meta+Shift+Digit3','Meta+Shift+Digit4','Meta+Shift+Digit5','Meta+Control+KeyQ','Meta+Control+Space',
 'Meta+Shift+KeyV','Meta+Alt+Shift+KeyV','Meta+Alt+KeyV',
 'Meta+Tab','Meta+Shift+Tab','Meta+Space','Meta+Alt+Space','Control+Space','Control+Alt+Space',
 'Meta+KeyI','Tab','Shift+Tab','Control+Tab','Control+Shift+Tab','F5','F6',
])
const keyNames = {' ':'Space',',':'Comma','.':'Period','[':'BracketLeft',']':'BracketRight','/':'Slash','\\':'Backslash',';':'Semicolon',"'":'Quote','-':'Minus','=':'Equal','`':'Backquote'}
export function bindingFromEvent(e) {
 if (!e || e.isComposing || e.keyCode===229 || ['Dead','Process','Unidentified'].includes(e.key)) return null
 let code=e.code
 if (!keyCode.test(code||'')) {
  const key=e.key||''
  code=/^[a-z]$/i.test(key)?'Key'+key.toUpperCase():/^\d$/.test(key)?'Digit'+key:keyNames[key]||key
 }
 if (!keyCode.test(code)) return null
 return [...modifiers.filter((_,i)=>[e.metaKey,e.ctrlKey,e.altKey,e.shiftKey][i]),code].join('+')
}
function validChord(chord,id) {
 if (typeof chord!=='string' || chord.length>80) return false
 const parts=chord.split('+'),code=parts.pop()
 return keyCode.test(code) && parts.every(p=>modifiers.includes(p))
  && parts.join('+')===modifiers.filter(p=>parts.includes(p)).join('+')
  && (parts.some(p=>p!=='Shift') || /^F\d+$/.test(code) || (code==='Space' && id==='quick-look' && !parts.length))
  && !reserved.has(chord)
}
export function effectiveBindings(overrides={}) {
 return Object.fromEntries(SHORTCUT_COMMANDS.map(c=>[c.id,Object.hasOwn(overrides,c.id)?(overrides[c.id]===null?[]:[overrides[c.id]]):[...c.keys]]))
}
export function validateBindings(value) {
 if (!plain(value) || Object.keys(value).length>SHORTCUT_COMMANDS.length) throw Error('快捷键方案格式无效。')
 const result={}
 for (const [id,chord] of Object.entries(value)) {
  if (!ids.has(id) || (chord!==null && !validChord(chord,id))) throw Error('此按键被系统或编辑操作保留，或快捷键格式不支持。')
  result[id]=chord
 }
 const used=new Map(), bindings=effectiveBindings(result)
 for (const c of SHORTCUT_COMMANDS) for (const chord of bindings[c.id]) {
  if (used.has(chord)) throw Error(`与“${used.get(chord)}”的快捷键冲突，请先修改该操作。`)
  used.set(chord,c.label)
 }
 return result
}
export function normalizeBindings(value) { try { return validateBindings(value||{}) } catch { return {} } }
export function resolveShortcut(e,overrides={}) {
 const chord=bindingFromEvent(e)
 if (!chord) return null
 const bindings=effectiveBindings(overrides)
 return SHORTCUT_COMMANDS.find(c=>bindings[c.id].includes(chord))?.id || null
}
export function formatBinding(chord) {
 if (!chord) return '未设置'
 const names={Meta:'⌘',Control:'⌃',Alt:'⌥',Shift:'⇧',Space:'空格',ArrowUp:'↑',ArrowDown:'↓',ArrowLeft:'←',ArrowRight:'→',Backspace:'⌫',BracketLeft:'[',BracketRight:']',Comma:',',Period:'.',Slash:'/',Backslash:'\\',Semicolon:';',Quote:"'",Minus:'-',Equal:'=',Backquote:'`'}
 const parts=chord.split('+'),code=parts.pop()
 return ['Control','Alt','Shift','Meta'].filter(p=>parts.includes(p)).map(p=>names[p]).join('')+(names[code]||code.replace(/^Key|^Digit/,''))
}
export function shortcutLabel(overrides,id) { return effectiveBindings(overrides||{})[id]?.map(formatBinding).join(' / ') || '未设置' }
export function shortcutPreset(name) { return name==='commander'?{'quick-look':'F3','file-new-folder':'F7','file-trash':'F8','search-open':'Alt+F7'}:{} }
export function createShortcutBackup(value) { return {format:'bento-shortcuts',version:1,bindings:validateBindings(value)} }
export function parseShortcutBackup(text) {
 if (typeof text!=='string' || new TextEncoder().encode(text).length>65536) throw Error('快捷键方案必须是不超过 64 KiB 的 JSON 文件。')
 let value
 try { value=JSON.parse(text) } catch { throw Error('快捷键方案 JSON 无效。') }
 if (!plain(value) || Object.keys(value).sort().join(',')!=='bindings,format,version' || value.format!=='bento-shortcuts' || value.version!==1) throw Error('不支持此快捷键方案格式或版本。')
 return validateBindings(value.bindings)
}
export function viewAccelerators(overrides) {
 const bindings=effectiveBindings(overrides)
 return Object.fromEntries(['view-icons','view-list','view-columns'].map(id=>[id,bindings[id][0]?.split('+').map(p=>({Meta:'Super',Control:'Control'}[p]||p.replace(/^Key|^Digit/,''))).join('+')||null]))
}
