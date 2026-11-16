# MacTools

本机 Mac 运维工具集。一个统一控制台按需拉起各个子服务，**平时不占任何端口**；
另有一个原生菜单栏 App 常驻右上角，随手看温度和功耗。

零第三方依赖：Node 只用标准库，Python 只用标准库，菜单栏 App 用 Swift + AppKit 直接编译。

---

## 功能一览

| 功能 | 形态 | 端口 | 能干什么 |
|---|---|---|---|
| 控制台 Manager | Node 网页 | 8800 | 卡片式管理所有子服务：启动 / 停止 / 看日志 / 内嵌打开；端口被占时自动接管复用 |
| macstat 实时状态 | 网页 + CLI | 8787 | CPU 温度、整机取电功率（负载/充电/损耗分解）、PD 电压电流、SoC 包功耗、CPU 频率、内存、电池健康，带 10 分钟实时曲线 |
| 磁盘空间占用报告 | 网页 | 8765 | du/df 只读扫描，按主目录 / ~/Library / Application Support / Containers / 已装应用 / 系统区域出 Top 排名 |
| 外接屏亮度跟随 | 网页 + CLI | 8766 | 内建屏亮度按可配置曲线同步到外接显示器，拖锚点调映射、一键开关、热重载 |
| 菜单栏 App | 原生 Swift | — | 状态栏常驻，看温度/功耗/电池/亮度，快捷启停服务；不占 Dock |

---

## 环境要求

| 项 | 要求 | 说明 |
|---|---|---|
| 系统 | 脚本部分 macOS 12+；菜单栏 App macOS 15+ | 部署目标钉在 15.0。**实测环境：macOS 27.0.1 / Apple Silicon (M1)**，更早版本未逐个验证 |
| 架构 | arm64 | 菜单栏 App 的编译目标硬编码 `arm64`；Intel 机需改 `TARGET`（见下文） |
| Python | 3.9+ | 直接用系统自带 `/usr/bin/python3`，无需装第三方包 |
| Node | ≥ 18 | 仅控制台与构建脚本需要 |
| 命令行工具 | Xcode Command Line Tools | **只有编译菜单栏 App 才需要**。`xcode-select --install`，装完 `swiftc` 可用 |
| macmon | 可选 | `~/.local/bin/macmon`，macstat 的温度与 SoC 功耗数据源；没有它温度一栏会缺 |

检查一遍：

```bash
node -v                                   # >= v18
/usr/bin/python3 -V                       # >= 3.9
xcode-select -p                           # /Library/Developer/CommandLineTools
swiftc --version                          # 仅编译菜单栏 App 需要
ls -l ~/.local/bin/macmon                 # 可选
```

---

## 快速开始

```bash
cd ~/Desktop/MacTools-v2
node manager.js          # 等价于 ./bin/mac-tools
```

打开 http://127.0.0.1:8800 —— 默认所有服务都是**停止**状态，在页面上点「启动」才会拉起进程。

想直接调命令行，把 `bin/` 加进 PATH，或建软链：

```bash
ln -s ~/Desktop/MacTools-v2/bin/macstat ~/scripts/macstat
# 或者：在项目里 npm link，六个命令一起进 PATH
```

命令行速查：

```bash
macstat -p          # 只看电源 / 取电 / 电池，秒回
macstat -n 3        # 采样 3 次全览（温度 + 功耗 + 电源）
macstat -w          # 终端持续监控
macstat-web         # 单独跑实时面板（默认 8787）
brightsync status   # 内建 / 外接亮度与映射目标
brightsync watch    # 亮度跟随常驻
disk-report 8765    # 单独跑磁盘扫描
```

---

## 构建与安装（完整流程）

脚本部分（Python / Node）**不需要编译**，直接可跑。只有菜单栏 App 需要 Swift 编译。
从零到「开机自启、状态栏常驻」一共四步：

### 第 1 步：准备脚本

无需构建。确认 shebang 与执行位在（从 git 克隆后通常已经是）：

```bash
chmod +x bin/*
```

### 第 2 步：编译菜单栏 App

```bash
node bin/build-menubar.js            # 编译 -> MacToolsMenu.app -> ad-hoc 签名
```

这一步脚本内部实际做了 5 件事：

1. 建目录 `MacToolsMenu.app/Contents/{MacOS,Resources}`
2. 编译：
   ```bash
   swiftc -O -target arm64-apple-macos15.0 native/MacToolsMenu.swift \
          -o MacToolsMenu.app/Contents/MacOS/MacToolsMenu
   ```
3. **校验 minos**：读 `otool -l` 里的 `minos`，若高于当前系统主版本直接报错退出
4. 生成 `Contents/Info.plist`（`LSUIElement=true` → 不占 Dock、不出现在 Cmd-Tab）
5. `codesign -s - -f MacToolsMenu.app` 做 ad-hoc 签名（失败不影响本地运行）

产物：`MacToolsMenu.app`，编译后约 140KB。该目录已写进 `.gitignore`，**仓库里不带二进制，需要自己编**。

> **为什么要钉 `-target arm64-apple-macos15.0`**
> 本机 `swiftc` 的默认 target 是 `arm64-apple-macosx28.0`（比系统高一档），
> 编出来的二进制 `minos=28`，双击直接报「不能与此版本的 macOS 配合使用」。
> 所以脚本显式钉住部署目标；15.0 兼顾向下兼容。**Intel 机器**请把脚本里的
> `TARGET` 改成 `x86_64-apple-macos15.0`，`MIN_SYSTEM` 同步改。

### 第 3 步：装开机自启

两处自启是独立的，按需装：

```bash
node bin/build-menubar.js --agent    # 菜单栏 App 自启（写 ~/Library/LaunchAgents/dev.mactools.menubar.plist）
brightsync install                   # 亮度跟随自启（写 dev.mactools.brightsync.plist）
```

卸载 / 停用：

```bash
node bin/build-menubar.js --unagent  # plist 保留，RunAtLoad 置 false
brightsync uninstall                 # 直接删 plist
```

> 在**非登录会话**（脚本、CI、远程 shell）里执行 `launchctl bootstrap` 可能报
> `Input/output error`。plist 本身是好的，下次登录会自动加载；或手动：
> `launchctl bootstrap gui/$UID ~/Library/LaunchAgents/dev.mactools.menubar.plist`

### 第 4 步：验证

```bash
node bin/build-menubar.js --status   # App 路径 / 进程 / LaunchAgent 状态
launchctl list | grep mactools       # 两处自启是否已装载
pgrep -fl MacToolsMenu               # 菜单栏进程
lsof -nP -iTCP:8800 -sTCP:LISTEN     # 控制台在听
```

打开 http://127.0.0.1:8800 能看到卡片、右上角状态栏出现 MacTools 图标，即安装完成。

### 改完代码怎么更新

| 改了哪儿 | 怎么做 |
|---|---|
| Python 脚本（`bin/*`、`lib/*.py`） | 面板服务需在控制台里重启一次；`watch` 进程要重启才换新代码 |
| 页面（`lib/dashboard.html`、面板内嵌 HTML） | 浏览器刷新即可；面板 HTML 内嵌在 Python 里，需重启服务 |
| 菜单栏源码（`native/MacToolsMenu.swift`） | `node bin/build-menubar.js --restart`（重新编译并重启 App） |
| 服务注册表（`lib/services.json`） | **必须重启 manager 进程**，它在启动时一次性读取注册表 |

### 常见构建问题

| 报错 | 原因 | 处理 |
|---|---|---|
| `不能与此版本的 macOS 配合使用` | 产物 minos 高于系统 | 调低 `TARGET` 里的版本号，重编 |
| `swiftc: command not found` | 没装命令行工具 | `xcode-select --install` |
| 编译成功但 `.app` 里没变化 / 残留 `MacToolsMenu.cstemp` | 安全软件拦截了「替换 app 内二进制」 | 手动删 `.cstemp`，产物本身是好的；或先退出 App 再编 |
| `bootstrap ... Input/output error` | 非登录会话执行 | 见上一节，plist 仍有效 |
| 菜单栏不显示 | 进程已退出 | 看 `~/Library/Logs/MacToolsMenu.log`；或 `open MacToolsMenu.app` 手起一次 |

---

## 服务详情

### macstat 实时状态（8787）

**面板**：控制台点「启动」或直接开 http://127.0.0.1:8787 。顶部大数字看当前值，
下方是 10 分钟实时曲线（温度 / 功耗 / 频率），采样间隔默认 1 秒。

**命令行**：

```bash
macstat [-n 采样次数] [-i 间隔毫秒] [-w] [-p] [--json] [--no-color]
```

| 参数 | 含义 |
|---|---|
| `-n, --samples` | 采样次数，默认 4 |
| `-i, --interval` | 采样间隔毫秒，最低 1000（默认 1000） |
| `-w, --watch` | 持续监控，Ctrl-C 退出 |
| `-p, --power` | 只看电源 / 取电 / 电池，不跑 macmon（秒回） |
| `--json` | 输出原始采样数据，方便喂给别的脚本 |
| `--no-color` | 禁用颜色，便于重定向到文件 |

面板字段：CPU 温度、整机取电功率（拆成负载 / 充电 / 损耗）、PD 档位与实测电压电流、
SoC 包功耗、CPU 频率（P/E 核）、内存占用、电池百分比 / 预计时间 / 循环次数 / 健康度。

### 磁盘空间占用报告（8765）

只读扫描，分阶段进行，页面上能看到「正在扫描 ~/Library…」这样的进度，扫完出 Top 排名：

1. `df` 磁盘总览
2. 主目录一级子项（最耗时）
3. `~/Library` 一级
4. `~/Library/Application Support`（应用数据）
5. `~/Library/Containers`
6. `/Applications` 已装应用
7. 系统区域：`/System/Library/AssetsV2`、`/private/var/{folders,db,log,vm}`、`/usr/local`、`/Library` 等

一次完整扫描约 1–3 分钟。省着用就直接 `disk-report 8765` 单跑，不进控制台。

### 外接屏亮度跟随（8766）

内建屏亮度一变，外接显示器按可配置的映射关系跟过去。用的是 macOS 原生亮度通道
（`DisplayServices`，即系统设置里那根亮度条背后的接口），所以外接屏在「显示器」设置里有亮度条才有效；
走的是真背光，不是软件调光。

**控制面板**（推荐）：控制台里点「外接屏亮度跟随 → 启动」，或直接开 http://127.0.0.1:8766 。
面板上能实时看内外亮度、一键开关跟随、拖锚点调映射曲线（带当前工作点提示）、调参数，改完点保存，
跟随进程 0.5 秒内自动重载。改了一半没保存时页面会标「未保存」，不会被自动刷新冲掉，也可以点「还原」放弃。

**命令行**：

```bash
brightsync status           # 看内建 / 外接亮度与映射目标（只读）
brightsync sync             # 同步一次
brightsync set 60           # 直接设外接屏 60%
brightsync on / off         # 开 / 关跟随（进程保留，随时切回）
brightsync map              # 打印映射对照表
brightsync watch            # 常驻跟随，Ctrl-C 退出
brightsync install          # 装 LaunchAgent：开机自启 + 崩溃自动拉起
brightsync uninstall        # 卸掉
brightsync reset            # 映射恢复默认（删运行时配置，回落模板）
```

注意「跟随进程」是独立于面板的常驻进程：面板关掉不影响跟随，面板只负责看和改配置。
进程状态记在 `~/Library/Application Support/MacTools/brightsync.pid`。

映射关系在 `~/Library/Application Support/MacTools/brightsync.json`（运行时配置，面板保存的就是它），
`anchors` 是 `[[内建%, 外接%], ...]` 的分段线性锚点，改完 `watch` 自动重载（0.5 秒内生效，不用重启）：

```json
"anchors": [[0, 0], [25, 18], [50, 40], [75, 68], [100, 100]]
```

仓库里只放默认模板 `lib/brightsync.default.json`；删掉运行时配置即回落到模板值
（或直接 `brightsync reset`）。这样调整映射不会弄脏工作区。

默认曲线让外接屏整体略暗于内建屏（暗环境下不刺眼），要 1:1 就写 `[[0,0],[100,100]]`。
想换成任意曲线（gamma、按时间段分段等），替换 `lib/brightsync_core.py` 里的 `map_brightness()`
函数体即可，调用方只认「进一个百分数、出一个百分数」。

其余参数：`deadband` 内建变化小于该值不响应（默认 2%）、`minStep` 外接变化小于该值不写
（默认 1%，防止频繁下发）、`clamp` 外接亮度上下限、`interval` 轮询间隔。

注意：内建屏合盖（clamshell 外接模式）时读不到内建亮度，`watch` 会跳过不动；
`watch` 期间手动拖外接屏的亮度条会被覆盖，这是跟随模式的预期行为。

日志：`~/Library/Logs/brightsync.log`。

---

## 菜单栏 App（MacToolsMenu）

**140KB** 的原生 App，不占 Dock，只在右上角状态栏留一个图标。不是 Electron —— 直接用 Swift + AppKit
的 `NSStatusBar` 编译。

它**不自己采集数据**：通过 manager 拉起 macstat 服务，再从 8787 的 `/api/status` 取快照，
5 秒刷新一次（后台队列 + 防重入，不会阻塞 UI）。所以数据源始终只有一份。

菜单内容：

- CPU 温度、整机取电功率（负载/充电/损耗分解）、PD 电压电流、SoC 功耗
- 电池百分比与预计时间、循环与健康度、内存、CPU 频率
- 「🔆 亮度」一节：内建/外接实测值、映射目标、跟随开关与进程 pid
- 底部：打开控制台、启动磁盘扫描、停止全部服务、重新采样、退出

亮度面板（8766）不会自动拉起 —— 守住「平时不占端口」的原则，没启动时菜单只显示一行
「亮度跟随 未启动」，点一下即可启动并打开面板。

构建与自启命令见上文「构建与安装」。排障日志：`~/Library/Logs/MacToolsMenu.log`。

---

## 新增一个子服务

控制台是数据驱动的，加服务不用改 `manager.js`：在 `lib/services.json` 的 `services` 里加一条，
**重启 manager** 就会出现在页面上。

```json
{
  "id": "mytool",
  "name": "我的工具",
  "desc": "一句话说明它干什么",
  "icon": "🧰",
  "port": 8790,
  "script": "mytool-web",
  "args": ["--port", "8790", "--no-open"],
  "note": "页面底部的补充说明，可以写依赖或注意事项"
}
```

| 字段 | 说明 |
|---|---|
| `id` | 唯一标识，同时是 URL 里的 key（`/api/services/<id>/start`），只允许字母数字和 `-` |
| `script` | `bin/` 下的脚本名，manager 用 `python` 字段指定的解释器执行 |
| `args` | 传给脚本的参数，端口一般也在这里显式写一遍 |
| `note` | 卡片上的灰色小字 |

约定：子服务都是 HTTP 服务，监听 `127.0.0.1`，提供 `GET /`（页面）与需要的 `/api/*`；
控制台通过 `/proxy/<id>/...` 反向代理访问，对外只暴露 8800 一个端口。

---

## 目录结构

```
MacTools-v2/
├── manager.js                  控制台（Node，零第三方依赖）
├── package.json                bin 映射与 npm scripts
├── MacToolsMenu.app/           编译产物（.gitignore，需自己编）
├── lib/
│   ├── services.json           服务注册表：新增工具只改这里
│   ├── dashboard.html          控制台页面
│   ├── brightsync_core.py      亮度读写 / 配置 / 映射（CLI 与面板共用）
│   └── brightsync.default.json 默认映射模板（运行时配置在 ~/Library/Application Support/MacTools/）
├── bin/
│   ├── mac-tools               控制台启动器
│   ├── macstat                 命令行速览（Python，秒级采样）
│   ├── macstat-web             实时面板服务（Python）
│   ├── disk-report             磁盘扫描服务（Python）
│   ├── brightsync              亮度跟随 CLI / 常驻进程
│   ├── brightsync-web          亮度跟随控制面板（Python）
│   └── build-menubar.js        菜单栏 App 构建脚本
├── native/
│   └── MacToolsMenu.swift      菜单栏 App 源码（单文件）
└── tools/
    └── push-to-github.sh       首次推送/新建远端仓库的辅助脚本（用 gh）
```

运行期产生的文件（都不在仓库里）：

| 路径 | 内容 |
|---|---|
| `~/Library/LaunchAgents/dev.mactools.{menubar,brightsync}.plist` | 两处开机自启 |
| `~/Library/Application Support/MacTools/brightsync.json` | 亮度映射运行时配置 |
| `~/Library/Application Support/MacTools/brightsync.pid` | 跟随进程 pid |
| `~/Library/Logs/{MacToolsMenu,brightsync}.log` | 日志 |

---

## 数据源与口径说明

- **SoC 温度 / 包功耗**：macmon，秒级，来自 Apple Silicon SMC hid 事件。
- **整机取电功率 / PD 档位 / 电池**：`ioreg AppleSmartBattery` 的 `PowerTelemetryData` 与 `AdapterDetails`，免 sudo。
  其中 `SystemPowerIn = SystemLoad + BatteryPower + AdapterEfficiencyLoss`。
  该读数本身由系统每 5~20 秒刷新一次，采集端按 5 秒 TTL 缓存，不必追求更高刷新率。
- **电池健康**：本工具按 `FullChargeCapacity / DesignCapacity` 计算（如 86.7%），
  `system_profiler` 用的是另一套算法（如 91%），两者口径不同，非故障。
- **屏幕亮度**：`DisplayServices.framework` 的 `DisplayServicesGetBrightness` /
  `DisplayServicesSetBrightness`（私有接口，系统设置里那根亮度条用的就是它）。内建屏和外接屏同一套 API，
  读写都是真背光。**不要**改用自己拼 DDC/CI 的 `IOAVServiceWriteI2C`：SetVCP 能下发，但部分显示器
  （如 27M2U-D）的 VCP 回读值滞后不更新，会把成功误判成失败。

---

## 排障与已知坑

- **改 `services.json` 不生效**：manager 启动时一次性读注册表，必须重启 manager（App 也要重起才会重拉）。
- **端口被别的进程占着**：manager 会识别并接管复用，不重复起；子服务自己起的时候端口冲突会直接报错。
- **沙箱/脚本环境里判活进程**：不要用 `ps` 判僵尸（受限环境可能禁 `ps`），本项目用
  `os.waitpid(pid, WNOHANG)` 判断并顺带回收，非自己子进程才退回 `kill(pid, 0)`。
- **常驻进程日志滞后**：stdout 重定向到文件时是块缓冲，已用
  `sys.stdout.reconfigure(line_buffering=True)` 修掉；自己写新服务记得加。
- **`launchctl bootstrap` 报 I/O error**：非登录会话老问题，plist 仍有效，见「构建与安装」第 3 步。

---

## 安全约定

扫描类工具均为**只读**：不删除、不移动、不修改任何文件。控制台只会拉起/停止自己启动的进程。
唯一会改变系统状态的是 brightsync —— 它写屏幕亮度（这是它的本职工作），
以及 `*.install` 会往 `~/Library/LaunchAgents` 放 plist。

---

MIT License
