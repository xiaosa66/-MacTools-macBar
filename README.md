# MacTools

本机 Mac 运维工具集。一个统一控制台按需拉起各个子服务，平时不占任何端口。

## 快速开始

```bash
node manager.js          # 或 ./bin/mac-tools
```

打开 http://127.0.0.1:8800 —— 默认所有服务都是**停止**状态，在页面上点「启动」才会拉起进程。

## 服务一览

| 服务 | 端口 | 说明 |
|---|---|---|
| 控制台 Manager | 8800 | Node 编写，负责拉起/停止子服务、端口冲突自动接管 |
| macstat 实时状态 | 8787 | CPU 温度 / 整机取电功率 / SoC 包功耗 / 频率 / 内存 / 电池 + 10 分钟实时曲线 |
| 磁盘空间占用报告 | 8765 | du/df 只读扫描，按主目录 / Library / 应用 / Containers / 系统区域排名 |
| 外接屏亮度跟随 | 8766 | 内建屏亮度按映射曲线同步到外接显示器，面板可开关、拖锚点调曲线 |

## 目录结构

```
MacTools/
├── manager.js              控制台（Node，零第三方依赖）
├── lib/
│   ├── services.json       服务注册表：新增工具改这里即可
│   ├── dashboard.html      控制台页面
│   ├── brightsync_core.py  亮度读写 / 配置 / 映射（CLI 与面板共用）
│   └── brightsync.json     映射锚点与参数
├── bin/
│   ├── mac-tools           控制台启动器
│   ├── macstat             命令行速览（Python，秒级采样）
│   ├── macstat-web         实时面板服务（Python）
│   ├── brightsync          亮度跟随 CLI / 常驻进程
│   ├── brightsync-web      亮度跟随控制面板（Python）
│   └── disk-report         磁盘扫描服务（Python）
└── package.json
```

## 单独使用命令行

```bash
macstat -p          # 只看电源/取电/电池，秒回
macstat -n 3        # 温度 + 功耗 + 电源全览
macstat -w          # 终端持续监控
macstat-web         # 单独跑实时面板
brightsync status   # 内建 / 外接亮度与映射目标
brightsync watch    # 亮度跟随常驻
disk-report 8765    # 单独跑磁盘扫描
```

建议把 `bin/` 加入 PATH，或在 `~/scripts` 建立软链接：

```bash
ln -s ~/Desktop/MacTools-v2/bin/macstat ~/scripts/macstat
```

## 外接屏亮度跟随（brightsync）

内建屏亮度一变，外接显示器按可配置的映射关系跟过去。用的是 macOS 原生亮度通道
（`DisplayServices`，即系统设置里那根亮度条背后的接口），所以外接屏在「显示器」设置里有亮度条才有效；
走的是真背光，不是软件调光。

**控制面板**（推荐）：控制台里点「外接屏亮度跟随 → 启动」，或直接开 http://127.0.0.1:8766 。
面板上能实时看内外亮度、一键开关跟随、拖锚点调映射曲线（带当前工作点提示）、调参数，改完点保存，
跟随进程 0.5 秒内自动重载。菜单栏 App 里也有一节「🔆 亮度」，可直接暂停/恢复跟随。

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
```

注意「跟随进程」是独立于面板的常驻进程：面板关掉不影响跟随，面板只负责看和改配置。
进程状态记在 `~/Library/Application Support/MacTools/brightsync.pid`。

映射关系在 `lib/brightsync.json`，`anchors` 是 `[[内建%, 外接%], ...]` 的分段线性锚点，
改完 `watch` 自动重载（0.5 秒内生效，不用重启）：

```json
"anchors": [[0, 0], [25, 18], [50, 40], [75, 68], [100, 100]]
```

默认曲线让外接屏整体略暗于内建屏（暗环境下不刺眼），要 1:1 就写 `[[0,0],[100,100]]`。
想换成任意曲线（gamma、按时间段分段等），替换 `bin/brightsync` 里的 `map_brightness()` 函数体即可。

其余参数：`deadband` 内建变化小于该值不响应（默认 2%）、`minStep` 外接变化小于该值不写
（默认 1%，防止频繁下发）、`clamp` 外接亮度上下限、`interval` 轮询间隔。

注意：内建屏合盖（clamshell 外接模式）时读不到内建亮度，`watch` 会跳过不动；
`watch` 期间手动拖外接屏的亮度条会被覆盖，这是跟随模式的预期行为。

日志：`~/Library/Logs/brightsync.log`。

## 菜单栏 App（MacToolsMenu）

**120KB** 的原生 App，不占 Dock，只在右上角状态栏留一个图标。不是 Electron —— 直接用 Swift + AppKit
的 `NSStatusBar` 编译，零第三方依赖（`swiftc` 属于 Xcode 命令行工具）。

它**不自己采集数据**：通过 manager 拉起 macstat 服务，再从 8787 的 `/api/status` 取快照，
5 秒刷新一次。所以数据源始终只有一份。

```bash
node bin/build-menubar.js            # 编译 -> MacToolsMenu.app -> ad-hoc 签名
node bin/build-menubar.js --agent    # 额外：生成 LaunchAgent 并装载（开机自启）
node bin/build-menubar.js --unagent  # 卸载自启
node bin/build-menubar.js --restart  # 改完代码：重新编译并重启 App
node bin/build-menubar.js --status   # 查看 App / LaunchAgent 状态
```

菜单内容：CPU 温度、整机取电功率（负载/充电/损耗分解）、PD 电压电流、SoC 功耗、
电池百分比与预计时间、循环与健康度、内存、CPU 频率；再往下一节是外接屏亮度
（内建/外接实测值、映射目标、跟随开关与进程 pid）；底部是打开控制台、启动磁盘扫描、
停止全部服务、重新采样、退出。

亮度面板（8766）不会自动拉起 —— 守住「平时不占端口」的原则，没启动时菜单只显示一行
「亮度跟随 未启动」，点一下即可启动并打开面板。

排障日志：`~/Library/Logs/MacToolsMenu.log`。

> LaunchAgent plist 生成后若 `launchctl bootstrap` 报 Input/output error（非本机登录会话执行时常见），
> plist 仍会生效 —— 下次登录会自动加载；或手动：
> `launchctl bootstrap gui/$UID ~/Library/LaunchAgents/dev.mactools.menubar.plist`

## 依赖

- Node.js >= 18（仅控制台需要）
- Python 3（子服务，仅用标准库）
- `~/.local/bin/macmon`：SoC 温度与包功耗数据源，免 sudo
- `du` / `df` / `ioreg`：系统自带

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

## 安全约定

扫描类工具均为**只读**：不删除、不移动、不修改任何文件。控制台只会拉起/停止自己启动的进程。
唯一会改变系统状态的是 brightsync —— 它写屏幕亮度（这是它的本职工作），
以及 `brightsync install` 会往 `~/Library/LaunchAgents` 放一个 plist。
