# Bento 优化与功能开发计划（含调研来源）

导出时间：2026-11-01（Asia/Shanghai）；状态核对：2026-11-01
产品名：**Bento**（GitHub [banduoba/bento](https://github.com/banduoba/bento)；本地目录常叫 Fspace，勿当产品名）
栈：Tauri 2 + React 19 + Vite，macOS 为主
说明：本文件由计划页与调研页合并导出；**已按 Bai 要求去掉「文件操作队列 / M6」**；后续开发由 Codex 进行，本助手不再开云端开发任务。

原 Page 链接（private，仅所有者可开；历史参考，后续开发以本地文档为准）：

- [Bento 优化与功能开发计划](https://cursor.com/canvas/store-3abb0371-0e99-4f61-a56e-efbf8fa2527e/da13a896-8a4c-406c-a1a3-e535f92ba5b0)
- [同类文件管理器吐槽与 Bento 功能方向](https://cursor.com/canvas/store-3abb0371-0e99-4f61-a56e-efbf8fa2527e/7edb1316-c4e7-4ec5-b515-6bbda18b090a)

---

## 关于「操作队列」：来源与为何从本文去掉

计划里原先的 **M6 文件操作队列（进度 / 暂停取消 / 冲突框 / ⌘Z 撤销）** 不是凭空加的，而是调研页把下列证据收成 Must 后写进开发计划的：

| 依据类型 | 内容 | 来源 |
| --- | --- | --- |
| Finder 槽点 | 无法暂停复制；大批量复制进度差 | 痛点聚类「批量操作、复制队列、压缩包」 |
| 用户原话 | 「拷两万文件进度条走一小时！」 | [X @laogeai](https://x.com/laogeai/status/2114498532103360967) |
| 用户原话 | 「真正的左侧树状导航和**暂停复制**，确实没有」 | [X @GShip223](https://x.com/GShip223/status/2113705874409832513) |
| 竞品卖点 | Ferry：复制队列可暂停；Path Finder Drop Stack / 批量；QSpace 暂存架（付费扩展） | 调研「竞品卖点基线」、[Ferry](https://ferry.indus3.org/) |
| 收费吐槽 | 压缩包、批量重命名被 QSpace 拆成扩展收费，被视为 table stakes | [r/macapps Forklift vs QSpace](https://www.reddit.com/r/macapps/comments/15wqdhx/forklift_vs_qspace_long/) |
| 热度条 | 「批量操作 / 复制队列」约 4 条独立来源（中等热度，低于地址栏/稳定性） | 调研页「痛点热度」 |

Bai 判断：**对当前 Bento 偏冗余，从路线图去掉。** 本文 Must / 顺序 / 依赖里已不再包含操作队列；依赖它的项（暂存架、压缩解压进度、批量重命名撤销、比较同步等）改注为「可选 / 自建简单进度即可」，不默认排期。

---

## 目标与原则

先接住 Finder 最常被骂的基础缺失，再做进阶功能。每个 PR 只做一件事，一个功能一个分支；本机跑 Tauri 验证、Bai 确认后再合 main。
口号：**稳、快、原生、离线。**

---

## 已完成（截至导出时）

### 最终原生交付核对（2026-11-01）

搜索与正则改动（PR #25、#26）已合入 main；当前 main 为 `a1b951e`。最终组合版本 `5b0db2a` 的历史验收记录为：安装至 `/Applications/Bento.app`，正常启动显示 4 个 pane 已加载、0 个加载中、0 个错误；session/config/view-settings 字节一致，默认与 work 工作区保留，无 app backup。验收范围以对应 PR 描述为准，不据此声称 Home/global/volumes/drag 已穷尽测试。

| 状态 | 项 |
| --- | --- |
| 已合 main | PR #1 UI 打磨 |
| 已合 main | PR #2 标题栏当前文件夹名 |
| 已合 main | PR #3 侧栏彩色图标 + 列表约 16px 图标 |
| 已合 main | PR #4 QLPreviewPanel Quick Look |
| 已合 main | PR #5 性能基线脚本 |
| 已合 main | PR #6 地址栏回车跳转 |
| 已合 main | PR #7 Enter 可配 + 列表键盘 |
| 已合 main | PR #8 ⌘X/⌘V 剪切移动 |
| 已合 main | PR #9 Tab 路径补全 + ⌥⌘C 复制路径 |
| 已合 main | PR #10 FSEvents 实时刷新 |
| 已合 main | PR #11 右键新建 + 模板 |
| 已合 main | PR #12 视图设置记忆 |
| 已合 main | PR #13 流式加载 + 虚拟列表 |
| 已合 main | PR #14 默认按修改日期排序（mtime desc） |
| 已合 main | PR #15 Tab 切 pane / F5 复制 / F6 移动到对侧 |
| 已合 main | PR #18 pane/tab 历史与会话恢复（be219ad） |
| 已合 main | PR #19 About / 检查更新（128d0be） |
| 已合 main | PR #23 原生简单文件操作与基础整批 Undo（d2486da）；PR #24 权限快捷方式（f9c344c） |
| 已合 main | 搜索（3b32f4c）与正则捕获替换（59aad98）；PR #25、#26 已合入 main。历史验收包括默认点击/Enter 定位父文件夹、滚动并选中，以及双文件捕获重命名后单次 ⌘Z 恢复原文件名和内容 |
| 已实现/待确认 | 标签/工作区、基础批量替换/编号/日期/大小写及预览；完整人工/原生验收未确认 |
| 已验收/待 Bai | 可展开文件夹树侧栏：实现位于 `feat/sidebar-folder-tree`，源码审查与原生验收通过，待 Bai 确认；尚未合入 main。验收覆盖箭头不切换 pane、子项点击只激活对应 pane、隐藏项开关与状态恢复、外部创建/删除及共享根目录重试刷新；完整视图显示 205 个文件夹。10k/100k debug QA 观察分别为 852/4172ms（含自动化按键与 AX 采集，不代表纯首屏时间或速度对比）。详见 feature branch / 后续 PR |
| 已暂缓 | 文件夹大小功能（用户明确暂缓，不排期） |

---

## Phase 总览

| 阶段 | 工作量（约） | 出口标准 |
| --- | --- | --- |
| Phase 0 | 1–2 人日 | 图标确认，#1–#4 合入 main（已完成） |
| Phase 1 Must | 约 22–30 人日（去掉队列后下调） | 剩余 Must 验收通过，基准数字达标 |
| Phase 2 Should | 2A 约 16–20 / 全部约 45 | 2A 先做；2B/2C 按反馈挑 |
| Phase 3 优化 | 10–12 人日 | 性能、刷新、图标、快捷键、信任 |
| Phase 4 后续 | 不排期 | 1–2 稳定后再评估 |

---

## Phase 1 Must（已去掉操作队列）

### M1 可编辑地址栏 + 面包屑 + 复制路径

- **价值**：r/MacOS 最高赞吐槽（88 赞）是没有地址栏；Windows 转 Mac 反复提。
- **工作量**：S，2–3 人日
- **状态**：已合（#6、#9）
- **验收要点**：⌘L；粘贴绝对路径回车；`~/` + Tab 补全；坏路径原地报错；面包屑可点；⌥⌘C 复制路径

### M2 真·剪切粘贴 ⌘X/⌘V + 右键新建文件

- **价值**：Finder 无 ⌘X、不能右键新建；FinderRight 等小工具专门补。
- **工作量**：S–M，3–4 人日
- **状态**：已合（#8、#11）
- **验收要点**：剪切半透明；跨 pane / 跨卷；新建 txt/md；同名「未命名 2」；templates/ 可扩展

### M3 实时刷新 + 大目录性能

- **价值**：ForkLift 视图不刷新导致误删；QSpace 1 万文件慢、假死。
- **工作量**：M，8–10 人日
- **状态**：已合（#5、#10、#13）
- **验收要点**：外部 touch/rm 1s 内同步；1 万文件首屏快；10 万可开且可取消；切换目录无监听泄漏

### M4 双栏打磨：F5/F6、Tab、独立历史、会话恢复

- **价值**：双栏是离开 Finder 的主因；ForkLift 4 Tab 失效、隐藏 pane 丢路径被骂。
- **工作量**：M，6–8 人日
- **状态**：Tab/F5/F6 已合（#15）；**前进后退历史 + 会话恢复已合 main（PR #18，be219ad）**
- **验收要点**：活动 pane 高亮；F5/F6 到对侧；每 pane 独立 ⌘[/⌘]；单双栏切换路径不丢；重启恢复路径与选中

### M5 视图设置记忆：全局默认 + 每文件夹覆盖

- **价值**：「every folder does whatever it wants」；ForkLift 列配置易丢。调研里几乎没有被一致称赞的竞品。
- **工作量**：S–M，3–4 人日
- **状态**：已合（#12）；另有默认 mtime 排序 #14
- **验收要点**：重启保持；单文件夹覆盖；应用到全部；路径失效回落默认

### ~~M6 文件操作队列~~（已去掉）

见上文「关于操作队列」。原验收（进度、暂停、冲突、⌘Z）不再作为 Must。

### M7 Enter 行为可配 + 全键盘可达

- **价值**：「assign ENTER to rename … anti-usability」。
- **工作量**：S，1–2 人日
- **状态**：已合（#7）
- **验收要点**：Enter=打开|重命名；F2 重命名；方向键/Home/End/PgUp/PgDn；纯键盘可完成常用流

---

## Phase 2 Should（摘要）

**2A 先做**

1. **文件夹大小**：后台计算、排序、缓存（依赖监听；原写依赖队列处改为可选进度 UI）。用户明确暂缓，不排期。
2. **搜索**：当前目录即时过滤 + 递归（mdfind / 通配符、位置列）；搜索（3b32f4c）与正则捕获替换（59aad98）通过源码审查及最终组合安装验收。默认点击/Enter 定位父文件夹、滚动并选中通过；双文件捕获重命名后单次 ⌘Z 恢复原文件名和内容通过。PR #25、#26 开放等待 Bai 确认，尚未合入 main（当前 main 为 f9c344c）。明确选择上下文菜单“打开”才打开文件。
3. **内置免费批量重命名**：替换/编号/日期/正则 + 预览（撤销可自建，不依赖原 M6）

**2B 导航与布局**

4. 标签页 + 工作区（依赖会话恢复）
5. 可展开文件夹树侧栏

**2C 批量与系统**

6. 暂存架 / Drop Stack（原依赖队列 → 可先做路径收集 + 一次复制/移动）
7. 压缩包浏览与带进度解压（原依赖队列 → 异步 + 简单进度即可）
8. 「在访达中显示」/ 对话框跳转：先技术调研，系统限制说清楚

---

## Phase 3 优化（非新功能）

- 性能基准与回归门槛（1 万/10 万首屏、删 3 文件、新标签）
- 视图永远与磁盘一致；失败提示含文件名
- 图标保真（特殊目录、iCloud 容器、外接盘、网络卷）
- 重命名/拖拽零闪烁；弹簧文件夹
- 快捷键两套预设（Finder / Commander）+ 可导出
- 列表行高与字体
- 离线、无账号、设置 JSON 备份
- 设置文案；VoiceOver / 焦点环

---

## Phase 4 后续（不排期）

文件夹比较/同步；远程 SFTP/SMB/WebDAV/S3；iCloud 状态；整行颜色标签；自定义右键/工具栏；大文件/重复文件；自然语言/AI 搜索（观望）。

---

## 建议开发顺序（去掉队列后）

已完成可跳过：地址栏、Enter、基准、FSEvents、虚拟列表、剪切、新建、视图记忆、Tab/F5/F6。

**接下来建议（给 Codex）：**

1. 已完成：pane 前进/后退历史 + 会话恢复（PR #18，be219ad）。
2. 搜索（3b32f4c）和正则捕获替换（59aad98）已通过源码审查及最终组合安装验收；PR #25、#26 已合入 main。用户已暂缓文件夹大小。
3. 可展开文件夹树侧栏已在 `feat/sidebar-folder-tree` 完成源码审查与原生验收，待 Bai 确认后再合入 main。
4. 后续按反馈选择 Phase 2A 批量重命名等候选项。

原「操作队列 → 撤销栈」串行周次已删除。

### 每周节奏（参考）

1. 选 1–2 个 PR 与验收清单
2. 开分支实现（Codex）
3. 本机 `~/Documents/04_tools/Fspace`：`npm run tauri dev` 验收
4. Bai 确认后合 main
5. 更新本文件状态

---

## 关键代码落点

- 快捷键：`src/shortcuts.js`
- 剪贴板剪切：`src/clipboard.js`
- 视图设置：`src/viewSettings.js` → app data `view-settings.json`
- 目录流式加载：`src/dirLoad.js`、`src-tauri/src/list_stream.rs`、`src-tauri/fswatch/src/stream.rs`
- FS 监听/增量：`src/fsWatch.js`、`src/fsApply.js`、`src-tauri/fswatch/`
- 模板：`~/Library/Application Support/com.bento.app/templates/`
- UI：`src/components/Pane.jsx`、`src/App.jsx`、`src/api.js`、`src-tauri/src/lib.rs`
- 文档：`docs/PITFALLS-drag-clipboard.md`、`scripts/bench/README.md`

---

## 风险与不做（Phase 1–2 稳定前）

不做：AI 搜索、完全替代系统打开/保存对话框、远程协议与同步。
注意：实时刷新仍是高风险面，需基准与回归；工作量按冲刺滚动，不压缩验收。

---

# 调研摘要

## 核心结论

1. Finder 最高频基础缺失：地址栏、⌘X、右键新建、Enter 打开。
2. 第三方最被骂：稳定性（QSpace 假死/大目录；ForkLift 视图不刷新丢数据；Path Finder / Commander One 崩或丢授权）。
3. 双栏/标签/工作区是迁移动力，细节做不好也被骂。
4. 视图设置记不住是老问题。
5. 搜索弱（无路径列、无 `*.*`）；有人自做 Everything 类工具。
6. 文件夹大小、批量重命名、压缩包被视为理应自带。
7. 系统对话框 /「在访达中显示」仍是迁移阻力。
8. 信任点：离线、买断/透明定价、不丢设置与数据。

**原调研建议的下一 Sprint**：地址栏 + 剪切/新建 + 实时刷新与大目录 + 双栏细节 + 视图记忆。（操作队列曾同列 Must，现已去掉。）

## 痛点热度（独立来源条数，非严谨统计）

| 主题 | 约 |
| --- | ---: |
| 地址栏 / 剪切 / 新建等基础操作 | 9 |
| 稳定性 / 性能 / 刷新 | 9 |
| 双栏 / 标签 / 工作区 / 树形导航 | 8 |
| 系统集成（对话框、在访达中显示） | 6 |
| 授权 / 定价 / 信任 | 6 |
| 搜索 | 5 |
| 远程 / 云盘 | 5 |
| 视图设置记忆 | 4 |
| 文件夹大小 / 磁盘空间 | 4 |
| 批量操作 / 复制队列 | 4 |
| 压缩包 | 3 |
| 标签颜色 / 自定义 | 3 |

## 数据覆盖与局限

- X 侧主要覆盖约 2026-10 近一个月；吐槽关键词组合命中少，推广贴多。主证据来自 Reddit、V2EX。
- 未系统抓：Mac App Store 评论、Product Hunt、AlternativeTo、即刻、知乎；少数派用到评分与功能描述。
- 部分 Reddit 帖为 2023–2024，同类问题 2025–2026 仍在提。

---

# 调研来源（完整列表）

## Reddit

- [What do people dislike about Finder?](https://www.reddit.com/r/MacOS/comments/1lgvcf7/what_do_people_dislike_about_finder/) — r/MacOS
- [Everyone says Finder needs a better Finder. What features are you actually missing?](https://www.reddit.com/r/MacOS/comments/1ueaqog/everyone_says_finder_needs_a_better_finder_what/) — r/MacOS
- [MacOS Finder - My biggest issues for usability](https://www.reddit.com/r/MacOS/comments/1t8abq8/macos_finder_my_biggest_issues_for_usability_i/) — r/MacOS
- [Why is Finder so damn terrible?](https://www.reddit.com/r/MacOS/comments/1utrmdo/why_is_finder_so_damn_terrible/) — r/MacOS
- [Mac user for almost 20 years and Finder still frustrates me](https://www.reddit.com/r/MacOS/comments/194g7m6/ive_been_a_mac_user_for_almost_20_years_and/) — r/MacOS
- [The heavily recommended Forklift is a nightmare of bugs](https://www.reddit.com/r/macapps/comments/1j93b6f/the_heavily_recommended_forklift_is_a_nightmare/) — r/macapps
- [Forklift 4 versus Path Finder](https://www.reddit.com/r/macapps/comments/1anb81u/forklift_4_versus_path_finder/) — r/macapps
- [Forklift vs QSpace (long)](https://www.reddit.com/r/macapps/comments/15wqdhx/forklift_vs_qspace_long/) — r/macapps
- [QSpace: Server down?](https://www.reddit.com/r/macapps/comments/1l7w0zb/qspace_server_down_and_should_qspace_be_allowed/) — r/macapps
- [Looking for 'Finder' Alternative](https://www.reddit.com/r/macapps/comments/1pfbymm/looking_for_finder_alternative/) — r/macapps
- [What is the best Finder alternative on mac?](https://www.reddit.com/r/macapps/comments/1alugzs/what_is_the_best_finder_alternative_on_mac/) — r/macapps
- [Finder replacement - details in post](https://www.reddit.com/r/macapps/comments/1udp7fw/finder_replacement_details_in_post/) — r/macapps
- [Commander One kind of uncomfortable and buggy?](https://www.reddit.com/r/macapps/comments/1kxhllg/am_i_the_only_one_who_finds_commander_one_kind_of/) — r/macapps
- [Done with Pathfinder](https://www.reddit.com/r/macapps/comments/11wo5b6/done_with_pathfinder/) — r/macapps

## V2EX

- [Qspace 必假死崩溃，不能正常使用](https://www.v2ex.com/t/1140341)
- [QSpace Pro 还是 ForkLift](https://www.v2ex.com/t/878836)
- [有没有深度使用 QSpace Pro 的，访达真的那么难用吗？](https://www.v2ex.com/t/984232)
- [MacOS finder 替代品有什么推荐的吗](https://www.v2ex.com/t/865346)
- [forklift 4 感觉问题多多，回滚 ForkLift 3](https://www.v2ex.com/t/1004005)

## 文章与产品站

- [体验 100 款文件管理工具总结](https://sspai.com/post/89538) — 少数派
- [This Third-Party File Manager Replaced Finder on My Mac](https://www.howtogeek.com/this-third-party-file-manager-replaced-finder-on-my-mac/) — How-To Geek
- [QSpace FAQ：如何替换访达](https://qspace.awehunt.com/zh-cn/faq/howto-replace-finder.html)
- [Ferry](https://ferry.indus3.org/)
- [Strata Files](https://stratafiles.app/)

## X

- [Sick of Finder bugs — anyone using a replacement?](https://x.com/flyosity/status/2115489987231658163) — @flyosity
- [一到 FileDialog 还是打回原形](https://x.com/daniel_du/status/2113505870382551370) — @daniel_du
- [左侧树状导航和暂停复制确实没有](https://x.com/GShip223/status/2113705874409832513) — @GShip223
- [用 Mac 这么久还不会新建 .txt](https://x.com/Clarrycy/status/2107398564846690493) — @Clarrycy
- [拖图片到文件夹一会儿行一会儿不行](https://x.com/xiancrong/status/2112434068877201871) — @xiancrong
- [Oil Find：Mac 版 Everything](https://x.com/I_am_oil_oil/status/2108196806798831958) — @I_am_oil_oil
- [FinderRight：访达 ⌘X、右键新建](https://x.com/appinn/status/2112942928423211225) — @appinn
- [ForkLift vs QSpace 选择建议](https://x.com/raphaelsoeiro/status/2115872495798784357) — @raphaelsoeiro
- [拷两万文件进度条走一小时](https://x.com/laogeai/status/2114498532103360967) — @laogeai（操作队列相关依据之一）

---

## 代表性原话（摘录）

> For me the biggest pain is the convoluted use of paths… I wish it had an address/path bar.
> — u/Advanced_Welcome1656，[r/MacOS](https://www.reddit.com/r/MacOS/comments/1lgvcf7)，88 赞

> Why is it just not possible to create a new File … from the right click … why is COMMAND+X not a standard option … ENTER Key to rename … so anti-usability.
> — [r/MacOS 可用性帖](https://www.reddit.com/r/MacOS/comments/1t8abq8)

> The file view wasn't updating correctly when moving/copying/deleting files. It resulted in some data loss.
> — u/dottedquad，[r/macapps ForkLift](https://www.reddit.com/r/macapps/comments/1j93b6f)

> Qspace 的小毛病贼多……解压一个多 g 的压缩包，点击解压半天没有任何反应
> — wk8023，[V2EX](https://www.v2ex.com/t/1140341)

> 几乎完全取代了访达，工作区和暂存架是最常用的两个功能。
> — wand，[V2EX](https://www.v2ex.com/t/984232)

> You can't consistently set up a global option for … sorting … every folder does whatever it wants
> — u/notthatevilsalad，[r/MacOS](https://www.reddit.com/r/MacOS/comments/1ueaqog)

---

*文件结束。开发请用 Codex；本助手仅在 Bai 明确要求时再参与编码。*
