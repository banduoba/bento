import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { act, create } from 'react-test-renderer'
const require = createRequire(import.meta.url)
const bridgeKey = '__bentoAppTestBridge'
const bundle = await build({ entryPoints: [fileURLToPath(new URL('../App.jsx', import.meta.url))], bundle:true, write:false, format:'cjs', platform:'node', jsx:'automatic', loader:{'.svg':'dataurl','.png':'dataurl'}, plugins:[{name:'app-boundaries',setup(b){
  b.onResolve({filter:/^react(?:\/.*)?$/},({path})=>({path:require.resolve(path),external:true}))
  b.onResolve({filter:/(?:^|\/)api(?:\.js)?$/},()=>({path:'api',namespace:'test'}))
  b.onResolve({filter:/(?:^|\/)components\/(Pane|Sidebar)$/},({path})=>({path:path.split('/').pop(),namespace:'test'}))
  b.onResolve({filter:/^@tauri-apps\//},({path})=>({path,namespace:'test'}))
  b.onLoad({filter:/.*/,namespace:'test'},({path})=>({loader:'js',contents:path==='api'
    ? `export const hasTauri=true; export const fileSrc=x=>x; export const api=new Proxy({}, {get:(_,k)=>(...a)=>globalThis.${bridgeKey}.api[k](...a)})`
    : path==='Pane'||path==='Sidebar'
      ? `import React from 'react'; export default function ${path}(props){return React.createElement('${path.toLowerCase()}-boundary',props)}`
      : path.endsWith('/window') ? `export const getCurrentWindow=()=>globalThis.${bridgeKey}.win`
      : path.endsWith('/event') ? `export const listen=(...a)=>globalThis.${bridgeKey}.listen(...a)`
      : path.endsWith('/core') ? `export const invoke=(...a)=>globalThis.${bridgeKey}.invoke(...a); export const convertFileSrc=x=>x; export class Channel{}`
      : path.endsWith('plugin-dialog') ? `export const open=async()=>null; export const confirm=(...a)=>globalThis.${bridgeKey}.confirm(...a)`
      : 'export const readText=async()=>""; export const writeText=async()=>{}'
  }))
}}] })
const mod={exports:{}}
new Function('require','module','exports',bundle.outputFiles[0].text)(require,mod,mod.exports)
const App=mod.exports.default
export const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}}
export async function mountApp(t, overrides={}) {
  const globals=['window','document','requestAnimationFrame','cancelAnimationFrame','IS_REACT_ACT_ENVIRONMENT',bridgeKey]
  const previous=Object.fromEntries(globals.map(k=>[k,globalThis[k]]))
  const storageDescriptor=Object.getOwnPropertyDescriptor(globalThis,'localStorage')
  const storage=new Map()
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,String(value)),removeItem:key=>storage.delete(key)}})
  globalThis.IS_REACT_ACT_ENVIRONMENT=true
  globalThis.window=new EventTarget()
  globalThis.document={activeElement:null,querySelector:()=>null,querySelectorAll:()=>[]}
  globalThis.requestAnimationFrame=()=>0; globalThis.cancelAnimationFrame=()=>{}
  const dialogs=[]
  let discard=false
  const events=new Map(), writes={session:[],config:[],views:[]}, replies=[]
  let closeHandler, closes=0, destroyed=0
  const win={setAlwaysOnTop:async()=>{},setTitle:async()=>{},onDragDropEvent:async()=>()=>{},onMoved:async()=>()=>{},onResized:async()=>()=>{},onCloseRequested:async f=>{closeHandler=f;return()=>{closeHandler=null}},close:async()=>{closes++},destroy:async()=>{closes++;destroyed++}}
  const api={fsearchStatus:async()=>({ready:true}),diskSpace:async()=>1000,homeDir:async()=>'/home',loadConfig:async()=>null,loadViewSettings:async()=>null,loadSession:async()=>null,listTemplates:async()=>[],resolvePath:async p=>p,saveConfig:async v=>writes.config.push(v),saveViewSettings:async v=>writes.views.push(v),saveSession:async v=>writes.session.push(v),sessionExitReply:async(id,allow)=>replies.push([id,allow]),...overrides}
  globalThis[bridgeKey]={api,win,listen:async(name,fn)=>{events.set(name,fn);return()=>events.delete(name)},invoke:async(cmd,args)=>{if(cmd==='session_exit_reply')replies.push([args.requestId,args.allowExit])},confirm:async(...args)=>{dialogs.push(args);return discard}}
  let renderer
  const error=console.error
  console.error=(...a)=>{if(!String(a[0]).startsWith('react-test-renderer is deprecated.'))error(...a)}
  try{await act(async()=>{renderer=create(React.createElement(App))})}finally{console.error=error}
  t.after(async()=>{await act(async()=>renderer.unmount());if(storageDescriptor)Object.defineProperty(globalThis,'localStorage',storageDescriptor);else delete globalThis.localStorage;for(const [k,v]of Object.entries(previous)){if(v===undefined)delete globalThis[k];else globalThis[k]=v}})
  return {writes,replies,events,api,dialogs,setDiscard(value){discard=value},get closes(){return closes},get destroyed(){return destroyed},get root(){return renderer.root},get panes(){return renderer.root.findAllByType('pane-boundary')},get sidebar(){return renderer.root.findByType('sidebar-boundary')},async run(fn){await act(async()=>{await fn()})},close(){let prevented=false;const pending=closeHandler?.({preventDefault(){prevented=true}});return{pending,prevented}},exit(id){return events.get('bento-session-exit-requested')?.({payload:{requestId:id}})}}
}
