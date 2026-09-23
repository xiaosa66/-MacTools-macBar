import Cocoa
import Foundation

// MacTools 菜单栏 App
//
// 数据源不自己采集：通过 manager (8800) 拉起 macstat 服务，
// 再从 macstat-web (8787) 的 /api/status 取统一快照。
// LSUIElement=1 + setActivationPolicy(.accessory) → 不占 Dock，只留状态栏。

let HOME = NSHomeDirectory()
let FALLBACK_ROOT = HOME + "/Desktop/MacTools-v2"
let MANAGER_PORT = 8800
let MACSTAT_PORT = 8787
let REFRESH_SECONDS: TimeInterval = 5

// ------------------------------------------------------------------ 基础工具

func resolveRoot() -> String {
    let parent = (Bundle.main.bundlePath as NSString).deletingLastPathComponent
    if FileManager.default.fileExists(atPath: parent + "/manager.js") {
        return parent
    }
    return FALLBACK_ROOT
}

/// 关键步骤落日志，方便排障：~/Library/Logs/MacToolsMenu.log
func logLine(_ msg: String) {
    let dir = HOME + "/Library/Logs"
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    let path = dir + "/MacToolsMenu.log"
    let line = "\(Date()) \(msg)\n"
    guard let d = line.data(using: .utf8) else { return }
    if FileManager.default.fileExists(atPath: path),
       let h = try? FileHandle(forWritingAtPath: path) {
        h.seekToEndOfFile()
        h.write(d)
        try? h.close()
    } else {
        try? d.write(to: URL(fileURLWithPath: path))
    }
}

func findNode() -> String {
    let candidates = [
        "/usr/local/bin/node",
        "/opt/homebrew/bin/node",
        HOME + "/.workbuddy/binaries/node/versions/22.22.2-3/bin/node",
    ]
    for c in candidates where FileManager.default.fileExists(atPath: c) {
        return c
    }
    return "/usr/bin/env"
}

func fetchJSON(_ urlString: String, timeout: TimeInterval = 3) -> [String: Any]? {
    guard let url = URL(string: urlString) else { return nil }
    let sem = DispatchSemaphore(value: 0)
    var result: [String: Any]?
    URLSession.shared.dataTask(with: url) { data, _, _ in
        defer { sem.signal() }
        guard let data = data,
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return }
        result = obj
    }.resume()
    _ = sem.wait(timeout: .now() + timeout)
    return result
}

func post(_ urlString: String) {
    guard let url = URL(string: urlString) else { return }
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.timeoutInterval = 5
    URLSession.shared.dataTask(with: req) { _, _, _ in }.resume()
}

func portOpen(_ port: Int, waitMs: Int = 300) -> Bool {
    var addr = sockaddr_in()
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    addr.sin_port = UInt16(port).bigEndian
    addr.sin_addr.s_addr = UInt32(0x7F000001).bigEndian  // 127.0.0.1

    let sock = socket(AF_INET, SOCK_STREAM, 0)
    guard sock >= 0 else { return false }
    defer { close(sock) }

    var tv = timeval(tv_sec: 0, tv_usec: __darwin_suseconds_t(waitMs * 1000))
    setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
    setsockopt(sock, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))

    let connected = withUnsafePointer(to: &addr) { ptr -> Bool in
        ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            connect(sock, $0, socklen_t(MemoryLayout<sockaddr>.size)) == 0
        }
    }
    return connected
}

// ------------------------------------------------------------------- Delegate

class AppDelegate: NSObject, NSApplicationDelegate {
    let root = resolveRoot()
    var statusItem: NSStatusItem!
    var timer: Timer?
    var lastData: [String: Any]?
    var lastError = ""
    var lastUpdate: Date?

    func applicationDidFinishLaunching(_: Notification) {
        logLine("boot: root=\(root) node=\(findNode())")
        NSApp.setActivationPolicy(.accessory)

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let img = NSImage(systemSymbolName: "gauge.medium", accessibilityDescription: "MacTools") {
            img.isTemplate = true
            statusItem.button?.image = img
        }
        statusItem.button?.title = " MacTools"
        statusItem.button?.toolTip = "MacTools · 点击展开实时监控"
        buildMenu()
        ensureInfra()

        timer = Timer.scheduledTimer(withTimeInterval: REFRESH_SECONDS, repeats: true) { [weak self] _ in
            self?.refresh()
        }
        refresh()
    }

    // ---------------------------------------------------------- 依赖保障

    func ensureInfra() {
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self = self else { return }
            if !portOpen(MANAGER_PORT) {
                logLine("manager 未运行，准备拉起")
                let node = findNode()
                let p = Process()
                p.executableURL = URL(fileURLWithPath: node)
                p.arguments = node == "/usr/bin/env"
                    ? ["node", self.root + "/manager.js", "--no-open"]
                    : [self.root + "/manager.js", "--no-open"]
                p.standardInput = nil
                try? p.run()
                for _ in 0..<40 {
                    Thread.sleep(forTimeInterval: 0.25)
                    if portOpen(MANAGER_PORT) { break }
                }
            }
            if portOpen(MANAGER_PORT) {
                post("http://127.0.0.1:\(MANAGER_PORT)/api/services/macstat/start")
                logLine("已请求 macstat 启动")
            } else {
                logLine("错误：manager 拉不起来")
            }
            for _ in 0..<40 {
                Thread.sleep(forTimeInterval: 0.25)
                if portOpen(MACSTAT_PORT) { break }
            }
            logLine("macstat 端口状态=\(portOpen(MACSTAT_PORT))")
            DispatchQueue.main.async { self.refresh() }
        }
    }

    // ------------------------------------------------------------ 数据刷新

    func refresh() {
        guard let snap = fetchJSON("http://127.0.0.1:\(MACSTAT_PORT)/api/status") else {
            lastError = portOpen(MACSTAT_PORT) ? "采样服务无响应" : "采样服务未运行"
            DispatchQueue.main.async { self.render() }
            return
        }
        lastError = ""
        lastData = snap
        lastUpdate = Date()
        DispatchQueue.main.async { self.render() }
    }

    func render() {
        let d = lastData
        let soc = d?["soc"] as? [String: Any]
        let pw = d?["power"] as? [String: Any]

        // 状态栏标题：温度 + 取电
        var brief = ""
        if let t = soc?["cpu_temp"] as? Double {
            brief += String(format: "%.0f°", t)
        }
        if let p = pw, p["on_ac"] as? Bool == true, let w = p["in_w"] as? Double, w > 0 {
            brief += String(format: "  ⚡%.0fW", w)
        }
        statusItem.button?.title = brief.isEmpty ? " MacTools" : " " + brief

        let menu = NSMenu()
        func row(_ title: String, _ key: Selector? = nil) {
            let i = NSMenuItem(title: title, action: key, keyEquivalent: "")
            if key != nil { i.target = self } else { i.isEnabled = false }
            menu.addItem(i)
        }

        let err = lastError
        if !err.isEmpty {
            row("⚠️ " + err)
            row("正在重试…")
            menu.addItem(NSMenuItem.separator())
        } else {
            if let t = soc?["cpu_temp"] as? Double {
                let note = t >= 85 ? "偏高" : (t >= 65 ? "偏热" : "正常")
                row(String(format: "🌡  CPU 温度    %.1f °C（%@）", t, note))
            }
            if let p = pw {
                if p["on_ac"] as? Bool == true, let w = p["in_w"] as? Double, w > 0 {
                    let parts = [
                        String(format: "负载 %.1fW", (p["sys_w"] as? Double) ?? 0),
                        String(format: "%@ %.1fW",
                               ((p["batt_w"] as? Double) ?? 0) >= 0 ? "充电" : "放电",
                               abs((p["batt_w"] as? Double) ?? 0)),
                        String(format: "损耗 %.1fW", (p["loss_w"] as? Double) ?? 0),
                    ]
                    row(String(format: "⚡  整机取电    %.1f W", w))
                    row("      " + parts.joined(separator: " + "))
                    if let v = p["in_v"] as? Double, let a = p["in_a"] as? Double {
                        row(String(format: "      PD %.1fV / %.2fA", v, a))
                    }
                } else {
                    row("⚡  整机取电    —（未接 AC）")
                }
            }
            if let w = soc?["soc_w"] as? Double {
                row(String(format: "🔌  SoC 功耗    %.1f W", w))
            }
            if let s = pw?["soc"] as? Int {
                var tail = ""
                if pw?["fully_charged"] as? Bool == true { tail = "已充满" }
                else if pw?["charging"] as? Bool == true {
                    if let m = pw?["eta_min"] as? Int, m > 0, m < 65535 {
                        tail = m >= 60 ? String(format: "%dh%02dm后满", m / 60, m % 60)
                                       : String(format: "%d 分钟后满", m)
                    } else { tail = "充电中" }
                } else if pw?["on_ac"] as? Bool == true { tail = "未充" }
                else if let m = pw?["eta_min"] as? Int, m > 0, m < 65535 {
                    tail = String(format: "可用 %dh%02dm", m / 60, m % 60)
                }
                row(String(format: "🔋  电池        %d%% %@", s, tail))
                if let c = pw?["cycles"] as? Int, let h = pw?["health"] as? Double {
                    row(String(format: "      循环 %d · 健康 %.0f%%", c, h))
                }
            }
            if let used = soc?["ram_used"] as? Double, let total = soc?["ram_total"] as? Double, total > 0 {
                row(String(format: "🧠  内存        %.1f / %.0f GB（%.0f%%）", used, total, used / total * 100))
            }
            if let p = soc?["pcpu_mhz"] as? Double, let e = soc?["ecpu_mhz"] as? Double {
                row(String(format: "⚙️  频率        p%.2f / e%.2f GHz", p / 1000, e / 1000))
            }
        }

        menu.addItem(NSMenuItem.separator())
        if let t = lastUpdate {
            let f = DateFormatter()
            f.dateFormat = "HH:mm:ss"
            row("🕐 " + f.string(from: t) + " · 每 \(Int(REFRESH_SECONDS))s")
        }
        row("打开控制台…", #selector(openConsole))
        row("启动磁盘扫描", #selector(startDisk))
        row("停止全部服务", #selector(stopAll))
        row("重新采样", #selector(restartMacstat))
        menu.addItem(NSMenuItem.separator())
        row("退出 MacTools", #selector(quit))

        statusItem.menu = menu
    }

    func buildMenu() {
        let m = NSMenu()
        m.addItem(NSMenuItem(title: "正在初始化…", action: nil, keyEquivalent: ""))
        statusItem.menu = m
    }

    // ------------------------------------------------------------ 菜单动作

    func openURL(_ u: String) {
        if let url = URL(string: u) { NSWorkspace.shared.open(url) }
    }

    @objc func openConsole() { openURL("http://127.0.0.1:\(MANAGER_PORT)/") }
    @objc func startDisk() {
        post("http://127.0.0.1:\(MANAGER_PORT)/api/services/disk/start")
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { self.openConsole() }
    }
    @objc func stopAll() {
        post("http://127.0.0.1:\(MANAGER_PORT)/api/services/disk/stop")
        post("http://127.0.0.1:\(MANAGER_PORT)/api/services/macstat/stop")
    }
    @objc func restartMacstat() {
        post("http://127.0.0.1:\(MANAGER_PORT)/api/services/macstat/start")
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.refresh() }
    }
    @objc func quit() {
        timer?.invalidate()
        NSApp.terminate(nil)
    }
}

// ---------------------------------------------------------------------- main

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
