// mac-app-kit 0.2.0 (ShellKit.swift). Vendored: don't edit here. Change it in the kit and vendor again.
// The native shell's shared parts for the family's Mac apps, compiled with each app's own
// main.swift (build.sh passes both to swiftc):
//   - ShellLog: one line in the server's log (server.log), which the app also writes to;
//   - ServerKeeper: runs the app's own copy of the local server with Bun, uses one of the
//     same version that already answers, replaces an app's server of another version,
//     looks again later when the port is taken (exit 3), and restarts after a crash,
//     waiting longer after each one in a row;
//   - PageView: the web view that fills the window, title bar included, and drags the
//     window from the page's header row like a title bar.
// Each app keeps its own window, menus, toolbar, settings and what it shows.

import AppKit
import WebKit

// ---------------------------------------------------------------- the log

enum ShellLog {
    // Set once at launch, before anything logs.
    nonisolated(unsafe) static var appName = "App"
    nonisolated(unsafe) static var path = "\(NSHomeDirectory())/server.log"
    // Past 8 MB the old part moves to server.1.log, and the log is the user's only.
    nonisolated(unsafe) static var rotate = false

    // A line in the server's log and in the system log. Opened for appending each time, so
    // the server's own lines are never overwritten.
    nonisolated static func write(_ text: String) {
        NSLog("\(appName): \(text)")
        let fd = open()
        guard fd >= 0 else { return }
        let line = "\(ISO8601DateFormatter().string(from: Date())) app: \(text)\n"
        _ = line.withCString { Darwin.write(fd, $0, strlen($0)) }
        close(fd)
    }

    nonisolated static func open() -> Int32 {
        let dir = (path as NSString).deletingLastPathComponent
        if !rotate {
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            return Darwin.open(path, O_WRONLY | O_APPEND | O_CREAT, 0o644)
        }
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        if let size = (try? FileManager.default.attributesOfItem(atPath: path))?[.size] as? Int, size > 8 * 1024 * 1024 {
            let old = (dir as NSString).appendingPathComponent("server.1.log")
            try? FileManager.default.removeItem(atPath: old)
            try? FileManager.default.moveItem(atPath: path, toPath: old)
        }
        return Darwin.open(path, O_WRONLY | O_APPEND | O_CREAT, 0o600)
    }
}

// ---------------------------------------------------------------- the server

@MainActor
final class ServerKeeper {
    struct Config {
        var port: Int
        var version: String // the app's version, which the server says in /api/state
        var versionEnv: String // "CSM_VERSION"
        var parentEnv: String // "CSM_PARENT_PID"
        var portEnv: String? = nil // also pass the port, as "TODOS_PORT"
        var bundleID: String? = nil // replace only a server inside an app with this bundle ID; nil: any app's
        var logStarts = false // a log line for each start
        var ownWords = "an app's" // in the log: "an app's server", "this app's server"
    }

    let config: Config
    var onExit: () -> Void = {} // the server stopped: say so on screen until it answers again
    private(set) var process: Process?
    private var startedAt = Date.distantPast
    private var launching = false // looking at what answers on the port before starting
    private var restartPending = false
    private var crashes = 0 // in a row, for the wait before the next restart
    private var portTaken = 0
    private var bunLogged = false
    var quitting = false

    init(_ config: Config) { self.config = config }

    var stateURL: URL { URL(string: "http://127.0.0.1:\(config.port)/api/state")! }

    // The server, bundled into server.js, and the page travel inside the app.
    static var serverDir: URL? {
        guard let dir = Bundle.main.resourceURL?.appendingPathComponent("server"),
              FileManager.default.fileExists(atPath: dir.appendingPathComponent("server.js").path) else { return nil }
        return dir
    }

    static var bunPath: String? {
        let home = NSHomeDirectory()
        return ["/opt/homebrew/bin/bun", "/usr/local/bin/bun", "\(home)/.bun/bin/bun"]
            .first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    func terminate() {
        quitting = true
        process?.terminate()
    }

    // Starts the server, unless one already answers on the port. One of this version is
    // used as it is. An older one, or one that doesn't say its version, is stopped first,
    // but only if it is an app's own copy of the server: a server run by hand from a
    // checkout is left alone, and the window uses it.
    func launch() {
        guard !launching, !restartPending, process == nil, !quitting else { return }
        launching = true
        var req = URLRequest(url: stateURL)
        req.timeoutInterval = 1
        let mine = config.version
        let port = config.port
        let bundleID = config.bundleID
        let own = config.ownWords
        URLSession.shared.dataTask(with: req) { data, response, _ in
            guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                Task { @MainActor in
                    self.launching = false
                    self.start()
                }
                return
            }
            let json = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            let info = json?["server"] as? [String: Any]
            let version = info?["version"] as? String
            let given = (info?["pid"] as? NSNumber).map { pid_t($0.int32Value) }
            if version == mine {
                Task { @MainActor in
                    self.launching = false
                    self.portTaken = 0
                    ShellLog.write("a server of this version (\(mine)) already answers on port \(port); using it")
                }
                return
            }
            DispatchQueue.global(qos: .utility).async {
                let pid = given ?? Self.portHolder(port)
                let what = "version \(version ?? "unknown"), pid \(pid.map { String($0) } ?? "unknown")"
                guard let pid, pid > 1, pid != getpid(), Self.isAppServer(pid, bundleID: bundleID) else {
                    Task { @MainActor in
                        self.launching = false
                        ShellLog.write("port \(port) is held by a server that isn't \(own) own (\(what)); using it")
                    }
                    return
                }
                ShellLog.write("stopping \(own) server of another version (\(what)) to start \(mine)")
                let stopped = Self.stop(pid, port: port, bundleID: bundleID)
                Task { @MainActor in
                    self.launching = false
                    if stopped {
                        self.start()
                    } else {
                        ShellLog.write("the old server (pid \(pid)) still holds port \(port)")
                        self.schedule(after: 30)
                    }
                }
            }
        }.resume()
    }

    // Starts the app's own copy of the server, with the app's version and pid: the server
    // quits on its own when the app is gone, so a crash or a force quit leaves no orphan.
    func start() {
        guard process == nil, !quitting else { return }
        guard let bun = Self.bunPath, let dir = Self.serverDir else {
            ShellLog.write("bun or the server files not found")
            return
        }
        if !bunLogged {
            bunLogged = true
            DispatchQueue.global(qos: .utility).async {
                ShellLog.write("bun \(bun), version \(Self.bunVersion(bun) ?? "unknown")")
            }
        }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: bun)
        p.arguments = [dir.appendingPathComponent("server.js").path]
        p.currentDirectoryURL = dir
        var env = ProcessInfo.processInfo.environment
        env[config.versionEnv] = config.version
        env[config.parentEnv] = String(getpid())
        if let portEnv = config.portEnv { env[portEnv] = String(config.port) }
        p.environment = env
        let fd = ShellLog.open()
        if fd >= 0 {
            let h = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
            p.standardOutput = h
            p.standardError = h
        }
        p.terminationHandler = { proc in
            let pid = proc.processIdentifier
            let code = proc.terminationStatus
            let signaled = proc.terminationReason == .uncaughtSignal
            Task { @MainActor in self.exited(pid: pid, code: code, signaled: signaled) }
        }
        do {
            try p.run()
            process = p
            startedAt = Date()
            if config.logStarts { ShellLog.write("started the server, pid \(p.processIdentifier), version \(config.version)") }
        } catch {
            ShellLog.write("could not start the server: \(error)")
            schedule(after: 30)
        }
    }

    // Exit code 3 is the server's "port taken": another copy answers, so look at it again
    // in a while. Any other exit is a crash: restart it, waiting longer after each crash
    // in a row (2 s up to a minute). One that ran for a minute starts the count again.
    private func exited(pid: pid_t, code: Int32, signaled: Bool) {
        guard process?.processIdentifier == pid else { return }
        process = nil
        if quitting { return }
        onExit()
        let ran = Date().timeIntervalSince(startedAt)
        if ran > 60 { crashes = 0; portTaken = 0 }
        let delay: TimeInterval
        if !signaled && code == 3 {
            portTaken += 1
            delay = min(30, 5 * pow(2, Double(portTaken - 1)))
            ShellLog.write("port \(config.port) is taken; looking again in \(Int(delay)) s")
        } else {
            crashes += 1
            delay = min(60, 2 * pow(2, Double(crashes - 1)))
            ShellLog.write("the server stopped (\(signaled ? "signal" : "exit code") \(code)) after \(Int(ran)) s; restarting in \(Int(delay)) s")
        }
        schedule(after: delay)
    }

    func schedule(after delay: TimeInterval) {
        guard !restartPending else { return }
        restartPending = true
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
            self.restartPending = false
            self.launch()
        }
    }

    // `bun --version`, for the log.
    nonisolated static func bunVersion(_ bun: String) -> String? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: bun)
        p.arguments = ["--version"]
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        guard (try? p.run()) != nil else { return nil }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // The pid listening on the port, from lsof.
    nonisolated static func portHolder(_ port: Int) -> pid_t? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
        p.arguments = ["-nP", "-iTCP:\(port)", "-sTCP:LISTEN", "-t"]
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        guard (try? p.run()) != nil else { return nil }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        let text = String(data: data, encoding: .utf8) ?? ""
        return text.split(whereSeparator: \.isNewline).compactMap { pid_t($0.trimmingCharacters(in: .whitespaces)) }.first
    }

    // A process's arguments, exactly as it got them (paths with spaces included).
    nonisolated static func arguments(of pid: pid_t) -> [String]? {
        var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
        var size = 0
        guard sysctl(&mib, 3, nil, &size, nil, 0) == 0, size > 4 else { return nil }
        var buf = [UInt8](repeating: 0, count: size)
        guard sysctl(&mib, 3, &buf, &size, nil, 0) == 0, size > 4 else { return nil }
        let argc = Int(buf.withUnsafeBytes { $0.load(as: Int32.self) })
        var i = 4
        while i < size && buf[i] != 0 { i += 1 } // the executable's path
        while i < size && buf[i] == 0 { i += 1 }
        var args: [String] = []
        while args.count < argc && i < size {
            let start = i
            while i < size && buf[i] != 0 { i += 1 }
            args.append(String(decoding: buf[start..<i], as: UTF8.self))
            i += 1
        }
        return args
    }

    // A process's working folder.
    nonisolated static func workingFolder(of pid: pid_t) -> String? {
        var info = proc_vnodepathinfo()
        let size = Int32(MemoryLayout<proc_vnodepathinfo>.size)
        guard proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, 0, &info, size) == size else { return nil }
        return withUnsafePointer(to: &info.pvi_cdir.vip_path) {
            $0.withMemoryRebound(to: CChar.self, capacity: Int(MAXPATHLEN)) { String(cString: $0) }
        }
    }

    // True for `bun …/server.ts` (or server.js) inside an app bundle's
    // Contents/Resources/server/: an app's own server, of any version, or only of the app
    // with this bundle ID. Older apps start it with a relative path from that folder, so the
    // working folder resolves it.
    nonisolated static func isAppServer(_ pid: pid_t, bundleID: String? = nil) -> Bool {
        guard let args = arguments(of: pid), let first = args.first,
              (first as NSString).lastPathComponent == "bun",
              let script = args.dropFirst().first(where: { !$0.hasPrefix("-") }) else { return false }
        var path = script
        if !path.hasPrefix("/") {
            guard let cwd = workingFolder(of: pid) else { return false }
            path = (cwd as NSString).appendingPathComponent(path)
        }
        path = (path as NSString).standardizingPath
        let dir = (path as NSString).deletingLastPathComponent
        guard ["server.ts", "server.js"].contains((path as NSString).lastPathComponent),
              dir.hasSuffix(".app/Contents/Resources/server") else { return false }
        guard let bundleID else { return true }
        let plist = (dir as NSString).appendingPathComponent("../../Info.plist")
        let info = NSDictionary(contentsOfFile: (plist as NSString).standardizingPath)
        return info?["CFBundleIdentifier"] as? String == bundleID
    }

    // Asks a server to quit and waits for the port to be free: 5 s, then it is killed.
    nonisolated static func stop(_ pid: pid_t, port: Int, bundleID: String? = nil) -> Bool {
        let free = { (seconds: Double) -> Bool in
            let until = Date().addingTimeInterval(seconds)
            while Date() < until {
                if portHolder(port) == nil { return true }
                usleep(250_000)
            }
            return portHolder(port) == nil
        }
        kill(pid, SIGTERM)
        if free(5) { return true }
        if isAppServer(pid, bundleID: bundleID) { kill(pid, SIGKILL) }
        return free(2)
    }
}

// ---------------------------------------------------------------- the page

// The page fills the window, title bar included, and a web view never lets a click there
// move the window. So the header row in the title bar drags the window like a title bar,
// except over the controls the page reports (holes). A double click does what System
// Settings says a title bar double click does.
class PageView: WKWebView {
    var holes: [CGRect] = [] // in the page's CSS pixels
    var titlebarHeight: CGFloat = 0 // in points, from the top
    // A page function told when the pointer comes and goes ("window.app?.pointer"), since
    // WebKit doesn't tell the page when the pointer leaves an inactive window. nil: none.
    var pointerFunction: String?

    private var exitArea: NSTrackingArea?
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        guard pointerFunction != nil else { return }
        if let exitArea { removeTrackingArea(exitArea) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self, userInfo: nil)
        addTrackingArea(area)
        exitArea = area
    }
    override func mouseEntered(with event: NSEvent) {
        super.mouseEntered(with: event)
        if let f = pointerFunction, event.trackingArea === exitArea {
            evaluateJavaScript("\(f)?.(true)", completionHandler: nil)
        }
    }
    override func mouseExited(with event: NSEvent) {
        super.mouseExited(with: event)
        if let f = pointerFunction, event.trackingArea === exitArea {
            evaluateJavaScript("\(f)?.(false)", completionHandler: nil)
        }
    }

    override func mouseDown(with event: NSEvent) {
        var p = convert(event.locationInWindow, from: nil)
        if !isFlipped { p.y = bounds.height - p.y }
        let css = CGPoint(x: p.x / pageZoom, y: p.y / pageZoom)
        guard p.y <= titlebarHeight, !holes.contains(where: { $0.contains(css) }), let window else {
            return super.mouseDown(with: event)
        }
        if event.clickCount == 2 {
            switch UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") {
            case "Minimize": window.performMiniaturize(nil)
            case "None": break
            default: window.performZoom(nil)
            }
        } else {
            window.performDrag(with: event)
        }
    }
}
