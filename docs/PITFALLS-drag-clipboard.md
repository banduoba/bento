# 拖拽 / 剪贴板 / 搜索预览：踩坑与经验

## 1. macOS 上 `onDragDropEvent` 的 position 是 CSS 逻辑像素，不是物理像素
- Tauri 类型标成 `PhysicalPosition`，但 wry（macOS）直接传 `draggingLocation`（窗口内逻辑点），tauri 不再乘缩放比。
- 实测：`devicePixelRatio=2`、`innerWidth=2056` 时，drop 坐标与鼠标 CSS 位置 1:1。
- 之前把它当物理像素乘/除 `devicePixelRatio`，命中全部错位，表现为「从 Finder 拖不进来」。
- 正确做法：`document.elementFromPoint(position.x, position.y)`，不要换算。

## 2. 拖到文件夹行，目标要取那一行，不是窗格当前目录
- 行上要带 `data-path` / `data-dir`，drop 时 `dest = row.dataset.path`。
- 要排除：拖进自己/子目录；所有源本来就在目标目录。

## 3. 「会话结束」回调早于窗口自己的 drop 事件
- `startDrag` 的 `ended` 回调比 `dde drop` 先到（实测相差 <5ms）。
- 用「进行中」标志（`dragState.internal`）区分内部/外部来源时，结束后要保留约 1.5s 宽限，否则 drop 时误判成外部。
- 策略：内部拖拽同卷移动、跨卷复制；Finder/微信等外部来源一律复制，不动对方源文件。

## 4. 从被遮住的 Bento 窗口拖文件
- 后台窗口一按下，macOS 会把整个窗口抬到最前，盖住拖拽目标，拖拽根本起不来。
- 解法：`acceptFirstMouse: true`（tauri.conf.json），再给 WryWebView 补 `shouldDelayWindowOrderingForEvent:` 返回 YES（`lib.rs::enable_background_drag`，wry 没暴露这个钩子）。
- 坑：实例可能被 KVO 换成 `NSKVONotifying_*` 子类，方法要加到真正的类（取 superclass）上才持久。
- 单击（无拖拽）仍会激活并抬起窗口，这是预期行为。

## 5. 拖出（startDrag）本身没问题，别先怀疑 data URL
- tauri-plugin-drag 2.1.1 的 `Base64Image` 接受 `data:image/png;base64,`，data URL 不是原因。
- 真正的问题是：
  - 某个构建里 `Pane.jsx` 缺 `trace`，在 `startDrag` 之前就抛 ReferenceError（error.log 里 `Can't find variable: trace`）。
  - 多选预览 `ctx.drawImage(img, …)` 引用了不存在的变量，静默退回旧图。
  - 搜索结果拖拽漏传必填的 `icon`，会话从不启动（`.catch(()=>{})` 把错误吞了）。
- 经验：吞错误的 `catch(() => {})` 要至少 trace；预览生成与拖拽启动集中在 `src/nativeDrag.js`。

## 6. 事件 payload 的字段不一定都有
- `leave` 事件没有 `position`，直接 `position.x` 会抛错，导致高亮永远清不掉。
- wry 的 `over` 事件会重复投递，drop 要按「路径+坐标+时间」去重，否则会拷贝两份。

## 7. 剪贴板：用原生 NSPasteboard，不要用 osascript
- `NSPasteboard.writeObjects([NSURL])` 写出 `public.file-url`，AppKit 读取时还会自动提供 `NSFilenamesPboardType`。
- Finder ⌘V 实测可粘贴；Finder 自己的 ⌘C 还额外带文件名文本和图标，微信如果不认，再补 `public.utf8-plain-text`。
- 写入放主线程（`run_on_main_thread` + channel 等结果）。
- 微信粘贴没有在本机自动化验证（会碰真实聊天），需手测。

## 8. 命中数不一致的真因：serde 命名
- Tauri 命令的**参数**自动 camelCase，**返回值结构体**不会。`TextPreview` 序列化成 `match_lines`，前端读 `matchLines`，所以右栏对所有文件都是 0 行命中。
- 修法：`#[serde(rename_all = "camelCase")]`；加单测断言 JSON 键名，防回归。
- 上一轮「截断分支加了匹配计算」实际没生效（仍 `Vec::new()` 直接 return），不要只看提交说明，要读代码/跑测试。
- 口径必须与 fsearch 一致：整串字面量（含 `:` 的词是过滤器，不参与）、smart case（模式无大写则忽略大小写）。fsearch 默认每文件只返回 5 行，已调到 20；索引只含 ≤1 MiB 文件。
- 命中在 256KB 截断之外时，后端统计 `hiddenHits`，右栏提示「命中位于已截断部分之外」，不再显示误导的「0 行命中」。

## 9. 构建 / 安装 / 测试
- `npm run build` 只生成 `src-tauri/target/release/bundle/macos/Bento.app`，**不会**覆盖 `/Applications/Bento.app`。用户测的是旧版 = 白修。改完要安装，并校验二进制哈希。
- 替换 App 后 ad-hoc 签名变了，完全磁盘访问权限可能失效，fsearch 会 `ready=false entries=0`，内容搜索无结果；需在系统设置里删掉 Bento 重新添加。
- 直接运行 `target/release/bento` 的测试二进制没有完全磁盘访问权限，无法测内容搜索，只能用 `cargo test`。
- 用 `( bin & )` 在工具 shell 里启动的 App 可能随 shell 结束被杀；用 `open /Applications/Bento.app`。
- 用户环境里有第三方拖拽辅助（弹「文件拖到这，可秒传给QQ/微信好友」），拖拽时会介入，偶尔让 Finder 端拖拽起不来，与 Bento 无关。

## 10. GUI 自动化测试技巧（CGEvent）
- 窗口不在前台时，`System Events` 的 keystroke 会发到别的 App；先 `set frontmost`，并确认前台进程名。
- 要测被遮住场景：Bento 缩小，Finder 叠在上面；Finder 端拖拽前先 `select` 目标文件并 activate。
- 拖拽过程的截图要在拖拽 hold 期间抓（并行 `sleep 2.6; screencapture`），松手后高亮已消失。
- 预先改 `config.json` 设好各窗格路径比 GUI 输入路径可靠；测完恢复备份。

## 11. 诊断
- `trace.log`：`~/Library/Application Support/com.bento.app/trace.log`，记录 `row-dragstart`、`startDrag invoke/started/ended/ERROR`、`dde enter/drop`（含坐标、命中元素、plan）、`clipboard ok/FAILED`。
- `error.log`：前端 window.onerror 持久化。
- 过滤 over 噪声：`grep -v "dde over" trace.log | tail -30`。

## 12. 目录自动刷新（FSEvents）
- 前端各窗格把「当前目录 + 展开的子目录」登记到 `src/fsWatch.js`，取并集交给后端 `set_watched`。切走、关掉自动刷新或窗格卸载时从并集拿掉，后端对不再需要的路径 `unwatch`。只监听可见窗格。根目录 `/`（canonicalize 之后仍是 `/` 的写法也不监听）。
- macOS 上 notify 用 FSEvents。事件先等约 100ms 收成一批（持续变化时大约每 100ms 一批，不是等完全静默），再发 `fs-changed`。
- 能确定直接子项时按路径增量更新：`removes` 删旧路径，`upserts` 是重新 stat 的条目（新增或按路径覆盖）。前端 `src/fsApply.js` 用路径做键，不整表替换。签名没变就保持原数组，避免空刷新。
- 整表重读（`reload: true`，前端再调 `list_dir`）是这些情况的退路，用来保证列表最终正确：
  - 重命名只来了一侧（移入、移出，或旧名/新名被拆到下一批）。同一批里旧路径已经不存在、新路径已经存在时，才增量删旧加新。这样 Finder 重命名不会留下旧名或重复项。
  - 事件落在被监听目录自己身上（目录被删/改名）。
  - `need_rescan`（队列丢事件）时，当前所有监听目录都整表重读。
  - 单批超过 512 个路径。
  - 符号链接的重命名：`canonicalize` 会穿过链接，对不上原来的文件名。
- 坑：
  - FSEvents 在 OS 层是递归的。notify 的 NonRecursive 会滤掉更深的路径；后端仍只认「父目录 ∈ 监听集合」的直接子项。孙路径靠展开子目录自己的监听。
  - FSEvents 报告真实路径（`/tmp` → `/private/tmp`）。监听集合用 canonicalize 后的路径做键，推给前端的 `dir` 和条目路径用登记时的原始前缀。前缀不对会和列表里的路径对不上，出现重复项。
  - 大小写不敏感卷上，旧名 `a.txt` 仍可能 canonicalize 到 `A.txt`。文件名对不上就当成旧名已消失。
  - 不要在持有 `watched` 锁时调用 `watch`/`unwatch`，也不要在持有这把锁时再去拿 `pending`。回调和防抖线程会分别拿这两把锁。
  - 防抖结束时目录已经不在监听集合里（用户已经切走）就丢掉这批。
  - 异步重读返回时要核对 tabId + path + showHidden 再写入。展开目录缓存已被清掉（`undefined`）时丢弃过期结果。

## 13. 启动卡死（死锁）：save_window_state 必须在主线程跑
- 现象：启动后窗口整个无响应 60s+（macOS 卡死报告：主线程在 run loop observer 回调里阻塞于 `pthread_mutex` → `psynch_mutexwait`，持锁线程是 tokio worker，卡在 `dispatch_semaphore_wait`）。
- 根因：前端 resize/move 防抖后调用 `save_window_state`，原先是 `async` 命令 → 在 tokio 线程执行。tauri-plugin-window-state 的 `save_window_state` 持有 `WindowStateCache` 锁，同时通过 `outer_position()` 等 getter **同步等待主线程**；而主线程恰好在处理窗口 Moved/Resized 事件，事件回调里也要拿同一把锁 → 互相等待。启动时恢复窗口位置/大小最容易触发。
- 与目录监听、拖拽补丁无关（出问题的安装包里还没有目录监听）。
- 修法：命令改成同步 `fn`（Tauri 同步命令在主线程执行），持锁者就不会再等主线程。
- 经验：凡是会「持锁 + 同步调用窗口 getter/`run_on_main_thread` 后阻塞等待」的逻辑，不要放在 async 命令（tokio 线程）里；macOS 卡死报告在 `/Library/Logs/DiagnosticReports/*.hang`，看主线程被哪个 turnstile 的哪个线程阻塞，再看该线程栈。
- Rust 的 `std` mpsc/park 在 macOS 上底层是 dispatch semaphore，所以栈里的 `_dispatch_semaphore_wait_slow` 不一定是 GCD，可能就是普通的阻塞等待。

## 14. 文件列表列（宽度 / 显示 / 种类）与压缩
- 列设置**按窗格各自保存**（`pane.colWidths` / `pane.colVisible`），不是全局：宽度写成窗格根元素上的 CSS 变量 `--c-template`、`--list-min`（`src/columns.js`），拖动中只改本窗格变量，松手才 `setCfg` 写盘（配置每次变化都会立即落盘，别在 mousemove 里写）。
- 名称列默认自适应(`minmax(200px,1fr)`)；拖名称列分隔线 = 固定宽度，双击恢复。右键表头勾选显示哪些列（修改日期/创建日期/大小/种类），「恢复到默认」。
- 窗格太窄放不下时，**自动按优先级隐藏次要列**（创建日期 → 种类 → 大小 → 修改日期），而不是横向滚动藏起来：最初用横向滚动，用户看到「日期列不见了」以为是丢了。名称列手动固定宽度时才允许横向滚动。
- 文件名过长只截断主干、保留扩展名（`funn….pdf`）：`.name-stem`(ellipsis) + `.name-ext`(flex:none)。
- 「种类」由前端扩展名表映射（`format.js::kindOf`），查不到显示「XXX 文件」。
- 压缩：`ditto` 一次只能压缩一个源（报 `Can't archive multiple sources`）。多选改为：临时目录里建符号链接 → `zip -r`（不加 `-y`，跟随链接存真实内容）；单个源仍用 `ditto --keepParent`。有回归测试 `zip_tests`。
- 调试 UI 的快办法：`npx vite --port N` 后用 headless Chrome 打开（api.js 有 mock 数据），`emulate({viewport})` 调宽度，`page.mouse` 右键/拖拽；比 macOS 辅助功能自动化稳定（系统权限还可能丢）。

## 15. 对齐 QSpace：列顺序/默认列、中间省略、相对日期、copy 命名
- 列顺序：名称 | 修改日期 | 创建日期 | 大小 | 种类；默认显示 修改日期/大小/种类，创建日期按需右键勾选。默认宽度压到 130/72/104，名称最小 160，所以 ~600px 的窗格能同时放下三列。
- 旧配置迁移：窗格带 `colsVersion`，<2 的旧列设置（当时默认「全显示」）直接丢弃套用新默认；之后只要用户改过就写 `colsVersion: 2`。以后再改默认列要继续升版本号。
- 文件名中间省略：拆成「前段 + 末段」两个 span，前段 `overflow:hidden; text-overflow:ellipsis`、末段 `flex:none`，纯 CSS 就能得到 `前面…后面.ext`；末段 = 扩展名+5 字符，至少 8 字符、至少 30% 名长；用 `Array.from` 按字符切避免劈开 emoji。容器要 `overflow:hidden`，否则窄列时末段会溢出盖住下一列。
- 日期与 QSpace 一致：今天/昨天只显示 `今天 10:16`，其余 `2026/9/25 00:07`（月日不补零）。
- 拷贝/移动重名命名（Rust `copy_name_path`）：`name copy.ext` → `name copy 1.ext` → `name copy 2.ext`…（最初是中文「副本」，按要求改成英文，生成的文件名不带中文）；对已带「copy[ N]」或旧版「副本[N]」的名字先去掉后缀再编号，不叠加「copy copy」。只用于拷贝/移动（`transfer`）；压缩包、新建文件夹、废纸篓仍用 `unique_path`（`name 2`）。有单测 `copy_name_tests`。

## 16. 「创建归档」对话框（复刻 QSpace）
- 入口：右键「压缩…」→ `ZipDialog`（位置 / 文件名 / 速度快·体积小·自定义(1-9 级) / 添加密码+保持 / 开启一键压缩 / 单独压缩）。默认文件名：单个项目=`项目名.zip`，多个项目=`当前文件夹名.zip`。
- 「开启一键压缩」：开启后右键直接出「压缩「x」」按上次设置压缩，同时多一个「压缩选项…」再打开对话框。设置存在 `cfg.zipPrefs`。
- 后端 `zip_paths(sources, destDir, options{name,level,password,separate}) -> Vec<String>`：统一用系统 `zip`（单个源也不再用 ditto，因为要支持级别/密码）；源同目录时 cwd=父目录+`-y`，分散时临时符号链接暂存；排除 `.DS_Store`；`单独压缩`每个源一个 zip；重名自动 `name 2.zip`。有单测 `zip_tests`（多源/单源/自定义名/单独/密码/跨目录）。
- 密码：`zip -P`（传统 ZipCrypto，macOS 归档实用工具和 `unzip` 都能解；强度弱）。命令行参数在压缩期间对同机其他进程可见。「保持」会把密码**明文**写进 `config.json`，所以只有勾了「保持」才存。
- 压缩结果通过 `showRowToast` 贴在新 zip 旁提示，并登记 ⌘Z（把生成的 zip 丢进废纸篓）。

## 17. 窗口置顶
- 工具栏图钉按钮 / ⌥⌘T 切换，`cfg.alwaysOnTop` 持久化；启动恢复和每次切换都走同一个 effect 调 `getCurrentWindow().setAlwaysOnTop()`。
- 需要 capability `core:window:allow-set-always-on-top`（`core:default` 不含），缺了会静默失败（已 trace）。
- ⌥⌘T 用 `e.code === 'KeyT'` 判断：macOS 上 ⌥T 的 `e.key` 是 `†`。
- 验证窗口层级不用 GUI 权限：`CGWindowListCopyWindowInfo` 看主窗口 `kCGWindowLayer`，置顶=5，普通=0。

## 18. README 素材与一个由截图发现的显示 bug
- README 用的是真实应用截图：造一个假 HOME（`HOME=/Users/Shared/demo ./bento`）隔离配置，预先写好 `config.json` 的窗格路径和 `.window-state.json` 的窗口大小，`touch -t`/`os.utime` 固定修改时间；用 `screencapture -l <窗口ID>` 截窗口（不需要辅助功能权限，被遮挡也能截；去掉 `-o` 带阴影）。窗口 ID 用 `CGWindowListCopyWindowInfo` 按 pid 查。
- 对话框、列菜单等无法在真机里自动点出来的界面，用 `vite` + headless Chrome 的 mock 数据截图（`deviceScaleFactor: 2`，`page.screenshot({clip})`）。
- 截图时发现文件名中间省略的 bug：`Meeting Notes.md` 显示成 `MeetingNotes.md`。原因是拆成「前段 + 末段」后，前段末尾的空格在 `white-space: nowrap` 下被折叠。修复：`.name-stem` / `.name-ext` 用 `white-space: pre`。

## 19. 「关于」面板与系统文案跟随系统语言变中文
- 现象：在中文系统上，About 面板的标签（版本等）、系统菜单项、原生对话框都是中文。
- 原因：标签语言由 App bundle 的本地化决定，而 Tauri 默认 bundle 没声明本地化，系统就按用户语言选。`PredefinedMenuItem::about(Some(name), Some(AboutMetadata))` 只能控制面板里的**内容**。
- 做法：`src-tauri/Info.plist`（Tauri 打包时自动合并）声明 `CFBundleDevelopmentRegion=en`、`CFBundleLocalizations=[en]`；About 内容（名称/版本/版权/简介/网址）在 `lib.rs` 里显式写英文；自定义菜单标题（File / Close Window / Window）也改英文以免菜单栏中英混杂。
- 副作用：原生文件选择面板等系统界面也变英文（应用自身界面仍是中文）。
