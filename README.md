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

## 目录结构

```
MacTools/
├── manager.js              控制台（Node，零第三方依赖）
├── lib/
│   ├── services.json       服务注册表：新增工具改这里即可
│   └── dashboard.html      控制台页面
├── bin/
│   ├── mac-tools           控制台启动器
│   ├── macstat             命令行速览（Python，秒级采样）
│   ├── macstat-web         实时面板服务（Python）
│   └── disk-report         磁盘扫描服务（Python）
└── package.json
```

## 单独使用命令行

```bash
macstat -p          # 只看电源/取电/电池，秒回
macstat -n 3        # 温度 + 功耗 + 电源全览
macstat -w          # 终端持续监控
macstat-web         # 单独跑实时面板
disk-report 8765    # 单独跑磁盘扫描
```

建议把 `bin/` 加入 PATH，或在 `~/scripts` 建立软链接：

```bash
ln -s ~/Desktop/MacTools-v2/bin/macstat ~/scripts/macstat
```

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
电池百分比与预计时间、循环与健康度、内存、CPU 频率；底部是打开控制台、启动磁盘扫描、
停止全部服务、重新采样、退出。

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

## 安全约定

所有扫描均为**只读**：不删除、不移动、不修改任何文件。控制台只会拉起/停止自己启动的进程。
