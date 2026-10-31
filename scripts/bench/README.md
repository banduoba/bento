# 性能基线

给后续性能改动对照用。这里只生成测试目录、测量、写报告，**不改变** Bento 怎么列目录、怎么听 FSEvents、怎么画虚拟列表。

在 Mac 上、性能 PR 前后各跑一遍，把两份报告贴到 PR 里。机器、启动方式（`npm run dev` 或 release 的 `.app`）、有没有清缓存，前后要一致。

需要 Node.js 18 或更新。`--rust` 还需要本机的 Rust（编 Bento 的那套即可）。命令都在仓库根目录执行。

## 三条命令

生成约 1 万个小文件：

```bash
npm run bench:fixture:10k
```

生成约 10 万个小文件（会提示磁盘和时间；不想等 3 秒就加 `--yes`）：

```bash
npm run bench:fixture:100k
npm run bench:fixture:100k -- --yes
```

无界面测量（默认测 1 万那个夹具：目录扫描，以及删除 3 个小文件）：

```bash
npm run bench:measure
```

等价写法：

```bash
./scripts/bench/baseline.sh fixture-10k
./scripts/bench/baseline.sh fixture-100k
./scripts/bench/baseline.sh measure
```

10 万夹具的测量不是默认项：

```bash
node scripts/bench/measure.mjs --preset 100k
```

和 `list_dir` 对齐的 Rayon 扫描（首次会编译一个独立小程序）：

```bash
node scripts/bench/measure.mjs --preset 10k --rust
```

先确认脚本没坏，可以跑自检。它只在临时目录放 250 个文件，不生成 1 万 / 10 万夹具：

```bash
npm run bench:self-check
```

## 磁盘和时间

每个文件写入 32 字节。文件系统一般按 4 KiB 一块分配，所以占的磁盘比逻辑体积大得多。目录项还会再占一点。

| 夹具 | 文件数 | 逻辑体积 | 按 4 KiB/文件估算 | 一块很快的 Linux 磁盘上的参考值 |
| --- | ---: | ---: | ---: | --- |
| 10k | 10,000 | 320,000 B（约 312.5 KB） | 约 40 MB | 生成 0.20 s，`du` 39.3 MB |
| 100k | 100,000 | 3,200,000 B（约 3.05 MB） | 约 400 MB | 生成 1.82 s，`du` 393.4 MB |

上面的秒数**不是 Mac 基线**。那块盘创建小文件异常快。请以你自己机器上命令打印的「生成耗时」和「磁盘占用」为准。APFS 上小文件同样常按 4 KiB 计，但更新一个 10 万项的目录可能更慢；留出一两分钟是稳妥的。空间不够时命令会直接退出，不会写到一半假装成功。

已经生成过、标记和文件数都对得上时，再跑会跳过。重建：

```bash
node scripts/bench/generate-fixture.mjs --preset 10k --force
```

夹具放在 `scripts/bench/fixtures/`，已加入 `.gitignore`。每个夹具里有一个隐藏的 `.bento-bench.json`。Bento 默认不显示隐藏文件，列表里就是正好 1 万或 10 万项。手测时不要打开「显示隐藏文件」。

用完可以删掉：

```bash
rm -rf scripts/bench/fixtures/10k scripts/bench/fixtures/100k
```

生成器拒绝往仓库根、家目录，或一个非空且不是本工具生成的目录里写。`--force` 也只删除带 `bento-bench` 标记的夹具。

## 无界面测了什么

`measure` 不开窗口，写 `scripts/bench/reports/baseline-<UTC>.json` 和同名 `.md`，并更新 `latest.json` / `latest.md`。报告目录已 gitignore，需要的话把文件贴进 PR。

| 字段 | 含义 |
| --- | --- |
| `headless.scan_node` | Node `readdir` + 64 路并发 `stat`，组装和 `list_dir` 相近的字段。便携对照，**不能**用来判断 Rust 扫描有没有变快。另有一次 `JSON.stringify`，近似 IPC 打包，不含界面。 |
| `headless.scan_rust` | 加上 `--rust` 才有。`scripts/bench/scan-rs` 按 `src-tauri/src/lib.rs` 的 `list_dir` / `make_entry` 做：`read_dir`、Rayon 并行 metadata、默认跳过点文件，再 serde 成 `{ entries }`。改了扫描实现要同步改这个小程序，否则它不再代表当前的 `list_dir`。应用不会编译它。 |
| `headless.delete3` | 把夹具里按文件名排序的前 3 个文件 `rename` 到同级临时目录，只计这一段，然后移回。这是 `trash()` 在主目录所在卷上的快速路径，不含选中、IPC 和列表刷新。测完文件都还在。 |

默认 1 次预热（不计入）+ 5 次样本，报告里有 min / median / mean / max。

这些都**不是**冷打开首屏。首屏还要加上进程、IPC 和 React 画出第一行。在那台 Linux 参考机上，1 万文件的 Node 扫描中位数大约 70–105 ms，`--rust` 大约 7 ms，3 个文件的 rename 中位数大约 0.05 ms。Node 和 Rust 只能各自跟下一次同引擎的结果比。Mac 上请重跑，不要把这些数当成要超越的基线。

`--cold` 会试一次 macOS `purge` 或 Linux 的 drop_caches，通常要 root。失败的话仍测热缓存，并在 JSON 的 `headless.cache` 里写明。

## 界面手测

冷打开首屏、界面里删除、新建标签都要开着 Bento。自动脚本只留空位。测 3 次，把三个数都传给 `record`（主值取中位数，样本保留）。

```bash
node scripts/bench/record.mjs --cold-open-ms 920,870,890 --delete3-ms 45,38,41 --new-tab-ms 310,280,290 --note "MacBook Pro，每次 sudo purge，npm run dev"
```

也可以指定某一份报告：`--report scripts/bench/reports/baseline-....json`。不指定就更新 `latest.json`。

### 冷打开 1 万文件，到第一行画出来

计的是：进程是新开的，目录缓存尽量是冷的，从路径确认到**第一行文件名出现**。不把「从点图标到窗口出来」算进去，也不等列表全部挂上。

1. ⌘Q 退出 Bento，确认进程没了。
2. 建议先清磁盘缓存：`sudo purge`（要密码，清的是整机缓存）。
3. 启动这次要对比的版本。等窗口停在默认目录，先不要打开夹具。
4. 设置里不要显示隐藏文件。
5. ⌘L，粘贴夹具的绝对路径（生成命令打印的「路径」）。从按下回车开始计时。
6. 出现第一行 `f……txt` 时停止。
7. ⌘Q，再 `sudo purge`，重复。做 3 次。

10 万目录不是这条基线的必测项。要测的话同样步骤，在 `--note` 里写上 100k。

### 界面里删除 3 个小文件

无界面的 rename 通常远小于能感觉到的延迟。这条才是按下快捷键到三行消失。

1. 打开 1 万夹具，等列表出来。
2. 点第一个文件，按住 Shift 点第三个。
3. 从按下 ⌘⌫ 开始，到这 3 行消失停止。
4. 文件进废纸篓。下一轮前从废纸篓放回，或者删掉夹具再生成。不要在文件已经少了 3 个的情况下拿去和「删除前」比文件数。

### 新建标签（自动脚本里的占位）

`gui.new_tab_ms` 默认是 `null`，`new_tab_status` 是 `placeholder`。自动脚本不测它。

产品里已经有标签：⌘T 用当前路径再开一个标签，窗格会再列一次这个目录。手测从按下 ⌘T 开始，到新标签里第一行文件名出现停止。写进报告后状态变成 `manual`。

## 报告里有什么

JSON 是完整记录，Markdown 方便贴进 PR。两边都包含：

- 时间、系统、CPU、Node 版本
- git 提交和分支，以及工作区是否干净
- 夹具路径、文件数、逻辑体积、`du -sk` 占用、生成耗时
- 上面的无界面数字
- 手填的首屏、界面删除、新标签（没填就是「未测」/ 占位）

比较两次时，对一下 `host`、`git.commit`，以及备注里的启动方式和有没有 `sudo purge`。
