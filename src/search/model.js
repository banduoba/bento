export const FORMATS = [
  { id: 'all', label: '全部' },
  { id: 'folder', label: '文件夹' },
  { id: 'image', label: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] },
  { id: 'document', label: '文档', extensions: ['doc', 'docx', 'pdf', 'md', 'txt'] },
  { id: 'spreadsheet', label: '表格', extensions: ['xls', 'xlsx', 'csv'] },
  { id: 'presentation', label: '演示', extensions: ['ppt', 'pptx', 'key'] },
  { id: 'video', label: '视频', extensions: ['mp4', 'mov', 'mkv'] },
  { id: 'archive', label: '压缩包', extensions: ['zip', 'rar', '7z', 'dmg'] },
]
export function matchesFormat(item, format) {
  if (format === 'all') return true
  if (format === 'folder') return item.is_dir
  const dot = item.name.lastIndexOf('.')
  return !item.is_dir && dot > 0 && !!FORMATS.find(f => f.id === format)?.extensions?.includes(item.name.slice(dot + 1).toLowerCase())
}
let sequence = 0
export const searchRequestId = () => `search_${Date.now().toString(36)}_${++sequence}`
export function searchError(error) {
  return error?.message || (typeof error === 'string' ? error : '搜索失败，请重试')
}
export function searchApi(invoke) {
  const searchQuery = (query, scope, root, showHidden, roots, mode, requestId, format = 'all') =>
    invoke('search_query', { query, scope, root: root ?? null, showHidden, roots: roots || [], mode: mode || 'name', requestId, format })
  return { searchQuery, cancelSearch: requestId => invoke('cancel_search', { requestId }),
    search: async (query, scope, root, showHidden, roots, mode) => (await searchQuery(query, scope, root, showHidden, roots, mode, searchRequestId())).items }
}
const beneath = (path, root) => path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`)
export function demoSearch(items, query, scope, root, showHidden, roots, mode, format = 'all') {
  if (!['pane', 'home', 'global'].includes(scope) || !FORMATS.some(f => f.id === format)) throw { code: 'invalidRequest', message: '无效搜索参数' }
  if (scope === 'pane' && !root?.startsWith('/')) throw { code: 'invalidRoot', message: '当前文件夹搜索需要目录路径' }
  const paths = scope === 'pane' ? [root] : scope === 'home' ? ['/Users/demo'] : roots || []
  const terms = query.trim().split(/\s+/).filter(Boolean)
  const predicates = terms.map(term => {
    if (term.startsWith('ext:')) return item => item.name.toLowerCase().endsWith(`.${term.slice(4).toLowerCase()}`)
    if (term.startsWith('re:')) { let re; try { re = new RegExp(term.slice(3)) } catch (e) { throw { code:'invalidQuery', message:`正则错误: ${e.message}` } }; return item => re.test(item.name) }
    const pattern = term.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
    const re = new RegExp(term.includes('*') || term.includes('?') ? `^${pattern}$` : pattern, 'i')
    return item => re.test(item.name)
  })
  const found = items.filter(item => (!paths.length || paths.some(root => beneath(item.path, root))) &&
    (showHidden || !item.path.split('/').some(p => p.startsWith('.'))) && matchesFormat(item, format) &&
    (mode !== 'content' || !item.is_dir) && predicates.every(match => match(item)))
  return { items: found.slice(0, 200).map(item => ({ ...item, dir: item.path.slice(0, item.path.lastIndexOf('/')),
    ...(mode === 'content' ? { lines:[{no:1,text:`示例内容：${query}`}],matches:1 } : {}) })),
    truncated:found.length > 200,incomplete:mode === 'content',warnings:mode === 'content' ? [{code:'demo',message:'浏览器演示使用模拟内容；请在 Bento 中搜索实际文件'}] : [],source:'demo' }
}
