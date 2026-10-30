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
