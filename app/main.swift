// Claude Session Monitor: a Mac app that shows your Claude Code sessions in a regular
// window and keeps its local server running.
//
// The window is a standard macOS window with a transparent title bar: the system's own
// close, minimize and zoom buttons, resize edges, dragging, Dock icon and Cmd-Tab. The
// page (http://127.0.0.1:4747/?embed) fills it and reflows to any size, like a web page.
// The toolbar holds the view switch, search and the sound switch, plus the connection
// status while the server doesn't answer. A menu bar item and the Dock icon show how
// many sessions need you.

import AppKit
import ServiceManagement
import UserNotifications
import WebKit

let port = 4747
let stripURL = URL(string: "http://127.0.0.1:\(port)/?embed")!
let stateURL = URL(string: "http://127.0.0.1:\(port)/api/state")!
let appName = "Claude Session Monitor"

// Obsidian surfaces: the window paints the body color so nothing shows through.
let obsidianBody = NSColor(srgbRed: 0x08 / 255, green: 0x09 / 255, blue: 0x0A / 255, alpha: 1)

extension NSToolbarItem.Identifier {
    static let view = NSToolbarItem.Identifier("view")
    static let search = NSToolbarItem.Identifier("search")
    static let live = NSToolbarItem.Identifier("live")
    static let sound = NSToolbarItem.Identifier("sound")
}

// The page fills the window, title bar included, and a web view never lets a click there
// move the window. So the header row in the title bar drags the window like a title bar,
// except over the controls the page reports (the counts, for one). A double click does
// what System Settings says a title bar double click does.
final class PageView: WKWebView {
    var holes: [CGRect] = [] // in the page's CSS pixels
    var titlebarHeight: CGFloat = 0 // in points, from the top

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

// A release on GitHub: its tag ("v0.4.0") and its page.
struct Release: Sendable {
    let version: String
    let page: String
}

enum UpdateError: Error, Sendable {
    case network(String), status(Int), unreadable
    var text: String {
        switch self {
        case .network(let m): return m
        case .status(let c): return "GitHub answered with status \(c). Try again later."
        case .unreadable: return "GitHub's answer couldn't be read. Try again later."
        }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, NSToolbarDelegate,
    WKNavigationDelegate, WKScriptMessageHandler, UNUserNotificationCenterDelegate {

    let defaults = UserDefaults.standard
    var window: NSWindow!
    var web: PageView!
    var statusItem: NSStatusItem!
    var liveLabel: NSTextField!
    var soundItem: NSToolbarItem?
    var viewSwitch: NSSegmentedControl?
    var searchItem: NSSearchToolbarItem?
    var statusSoundItem: NSMenuItem!
    var loginItem: NSMenuItem!
    var liveState: Bool? = nil // nil while connecting
    var settingsWindow: NSWindow?
    var settingsSound: NSButton?
    var settingsLogin: NSButton?
    var settingsSize: NSPopUpButton?
    var settingsHookState: NSTextField?
    var settingsHookButton: NSButton?
    var settingsUpdates: NSButton?
    var statusUpdateItem: NSMenuItem!
    var availableUpdate: Release?
    var sizeMenus: [NSMenu] = []
    var server: Process?
    var serverStartedAt = Date.distantPast
    var quitting = false
    var pageLoaded = false

    // MARK: launch

    func applicationDidFinishLaunching(_ notification: Notification) {
        startServer()
        buildMainMenu()
        buildWindow()
        buildStatusItem()
        // Open at Login is off until you turn it on in the menu bar item's menu.
        Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in
            Task { @MainActor in self.refreshStatus() }
        }
        refreshStatus()
        loadWhenReady()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate()
        keepHookCurrent()
        // Updates: a quiet look at GitHub soon after launch, then once a day.
        defaults.register(defaults: ["checkUpdates": true])
        UNUserNotificationCenter.current().delegate = self
        DispatchQueue.main.asyncAfter(deadline: .now() + 10) { self.checkQuietly() }
        Timer.scheduledTimer(withTimeInterval: 24 * 60 * 60, repeats: true) { _ in
            Task { @MainActor in self.checkQuietly() }
        }
        // After the window is up: say what's missing, or offer to connect Claude Code.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
            if !self.checkRequirements() { self.offerHook() }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        quitting = true
        server?.terminate()
    }

    // Clicking the Dock icon (or opening the app again) brings the window back.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showWindow()
        return false
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    // MARK: server

    // The server, the page and the hook travel inside the app (build.sh copies them).
    var serverDir: URL? {
        guard let dir = Bundle.main.resourceURL?.appendingPathComponent("server"),
              FileManager.default.fileExists(atPath: dir.appendingPathComponent("server.ts").path) else { return nil }
        return dir
    }

    var bunPath: String? {
        let home = NSHomeDirectory()
        return ["/opt/homebrew/bin/bun", "/usr/local/bin/bun", "\(home)/.bun/bin/bun"]
            .first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    // The hook needs jq; recent macOS ships it.
    var jqPath: String? {
        ["/usr/bin/jq", "/opt/homebrew/bin/jq", "/usr/local/bin/jq"].first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    // Starts `bun server.ts` from the app's own copy. If another copy already holds the
    // port, this one exits right away and the window uses the running one.
    func startServer() {
        guard let bun = bunPath, let dir = serverDir else {
            NSLog("\(appName): bun or the server files not found")
            return
        }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: bun)
        p.arguments = ["server.ts"]
        p.currentDirectoryURL = dir
        let logDir = "\(NSHomeDirectory())/.claude-session-monitor"
        try? FileManager.default.createDirectory(atPath: logDir, withIntermediateDirectories: true)
        let log = "\(logDir)/server.log"
        if !FileManager.default.fileExists(atPath: log) { FileManager.default.createFile(atPath: log, contents: nil) }
        if let h = FileHandle(forWritingAtPath: log) {
            h.seekToEndOfFile()
            p.standardOutput = h
            p.standardError = h
        }
        p.terminationHandler = { _ in
            Task { @MainActor in self.serverExited() }
        }
        do {
            try p.run()
            server = p
            serverStartedAt = Date()
        } catch {
            NSLog("\(appName): could not start the server: \(error)")
        }
    }

    // Restart a server that dies. One that quits within seconds most likely found the
    // port taken by another copy, so wait longer before trying again.
    func serverExited() {
        server = nil
        if quitting { return }
        let quick = Date().timeIntervalSince(serverStartedAt) < 3
        DispatchQueue.main.asyncAfter(deadline: .now() + (quick ? 30 : 2)) {
            if self.server == nil && !self.quitting { self.startServer() }
        }
    }

    // MARK: window

    func buildWindow() {
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 960, height: 420),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false)
        window.title = appName
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.appearance = NSAppearance(named: .darkAqua) // the Obsidian theme is dark only
        window.backgroundColor = obsidianBody
        window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 640, height: 260) // room for the header and the toolbar
        window.delegate = self
        window.tabbingMode = .disallowed

        // An empty unified toolbar makes the title bar tall enough for the page header to
        // sit on the same line as the window buttons, the way native apps do it.
        let toolbar = NSToolbar(identifier: "main")
        toolbar.delegate = self
        toolbar.displayMode = .iconOnly
        toolbar.allowsUserCustomization = false
        window.toolbar = toolbar
        window.toolbarStyle = .unified
        window.titlebarSeparatorStyle = .none

        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "strip") // the page asks for the alert sound
        web = PageView(frame: .zero, configuration: config)
        web.setValue(false, forKey: "drawsBackground")
        web.navigationDelegate = self
        web.autoresizingMask = [.width, .height]
        if let content = window.contentView {
            web.frame = content.bounds
            content.addSubview(web)
        }

        // Where you left it, as macOS restores any window; the first time, a size that
        // fits three columns and two rows, at the top of the main screen.
        if !window.setFrameUsingName("MainWindow") {
            let z = autoZoom(for: NSScreen.main)
            let v = (NSScreen.main ?? NSScreen.screens[0]).visibleFrame
            let size = NSSize(width: min(v.width - 40, 912 * z), height: min(v.height - 40, 420 * z))
            window.setFrame(NSRect(x: v.minX + 20, y: v.maxY - size.height - 20, width: size.width, height: size.height), display: false)
        }
        window.setFrameAutosaveName("MainWindow")
        applyZoom()
    }

    func showWindow() {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate()
    }

    // The red button hides the window instead of closing the app; the Dock icon or the
    // menu bar item brings it back.
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        window.orderOut(nil)
        return false
    }

    func windowDidResize(_ notification: Notification) { syncPageChrome() }
    func windowDidChangeScreen(_ notification: Notification) { applyZoom() }
    func windowDidEnterFullScreen(_ notification: Notification) { syncPageChrome() }
    func windowDidExitFullScreen(_ notification: Notification) { syncPageChrome() }

    // Tells the page where the window buttons are, so its header lines up with them and
    // leaves room on the left (buttons) and right (toolbar items).
    func syncPageChrome() {
        // The title bar's height, where the page's header row drags the window. None in full screen.
        web?.titlebarHeight = window.styleMask.contains(.fullScreen) ? 0 : window.frame.height - window.contentLayoutRect.height
        guard pageLoaded, let content = window.contentView,
              let close = window.standardWindowButton(.closeButton),
              let zoomButton = window.standardWindowButton(.zoomButton) else { return }
        let z = zoom
        let fullScreen = window.styleMask.contains(.fullScreen)
        let closeFrame = close.convert(close.bounds, to: content)
        let center = fullScreen ? 24 * z : content.bounds.height - closeFrame.midY
        let lightsEnd = fullScreen ? 0 : zoomButton.convert(zoomButton.bounds, to: content).maxX
        // The header row is 24 px tall, centered on the window buttons. Measured on screen,
        // the page's row rendered one device pixel below the native controls, so it goes
        // up by exactly one (half a point on a Retina screen).
        let onePixel = 1 / (window.screen?.backingScaleFactor ?? 1)
        let top = max(4, (center - onePixel) / z - 12)
        let slot = max(0, (lightsEnd + 12) / z - 16) // the header starts 16 px in
        // The toolbar items sit on the right; the header stops short of the first one.
        var firstItemX = content.bounds.width - 150
        if let seg = viewSwitch, seg.window != nil {
            firstItemX = min(firstItemX, seg.convert(seg.bounds, to: content).minX)
        }
        let right = max(0, content.bounds.width - firstItemX + 12) / z
        let js = """
        (() => { const s = document.documentElement.style;
          s.setProperty('--csm-chrome-top', '\(top)px');
          s.setProperty('--csm-lights-w', '\(slot)px');
          s.setProperty('--csm-chrome-right', '\(right)px');
          requestAnimationFrame(() => window.csm?.reportChrome?.()); })();
        """
        web.evaluateJavaScript(js, completionHandler: nil)
    }

    // MARK: toolbar

    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        [.flexibleSpace, .view, .search, .live, .sound]
    }

    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        [.flexibleSpace, .view, .search, .live, .sound]
    }

    func toolbar(_ toolbar: NSToolbar, itemForItemIdentifier id: NSToolbarItem.Identifier,
                 willBeInsertedIntoToolbar flag: Bool) -> NSToolbarItem? {
        switch id {
        case .view:
            // Last 7 Days, All Sessions and Scheduled, like the view switch in Mail or Finder.
            let seg = NSSegmentedControl(labels: ["Last 7 Days", "All Sessions", "Scheduled"], trackingMode: .selectOne,
                                         target: self, action: #selector(viewChanged(_:)))
            for (i, symbol) in ["square.grid.2x2", "clock.arrow.circlepath", "calendar.badge.clock"].enumerated() {
                seg.setImage(NSImage(systemSymbolName: symbol, accessibilityDescription: nil), forSegment: i)
                seg.setImageScaling(.scaleProportionallyDown, forSegment: i)
            }
            seg.selectedSegment = 0
            viewSwitch = seg
            let item = NSToolbarItem(itemIdentifier: id)
            item.view = seg
            item.label = "View"
            return item
        case .search:
            let item = NSSearchToolbarItem(itemIdentifier: id)
            item.searchField.placeholderString = "Search all sessions"
            item.searchField.target = self
            item.searchField.action = #selector(searchChanged(_:))
            item.label = "Search"
            searchItem = item
            return item
        case .live:
            let item = NSToolbarItem(itemIdentifier: id)
            liveLabel = NSTextField(labelWithString: "")
            liveLabel.font = .systemFont(ofSize: NSFont.systemFontSize)
            item.view = liveLabel
            item.label = "Connection"
            paintLive()
            return item
        case .sound:
            let item = NSToolbarItem(itemIdentifier: id)
            item.label = "Sound"
            item.target = self
            item.action = #selector(toggleSound)
            soundItem = item
            paintSound()
            return item
        default:
            return nil
        }
    }

    // The connection shows only when something is off: "Connecting…" at launch,
    // "Offline" in red when the server stops answering. While it's live, nothing.
    func setLive(_ ok: Bool?) {
        guard ok != liveState, let toolbar = window?.toolbar else { return }
        liveState = ok
        let shown = toolbar.items.firstIndex { $0.itemIdentifier == .live }
        if ok == true, let shown {
            toolbar.removeItem(at: shown)
        } else if ok != true, shown == nil {
            let at = toolbar.items.firstIndex { $0.itemIdentifier == .sound } ?? toolbar.items.count
            toolbar.insertItem(withItemIdentifier: .live, at: at)
        }
        paintLive()
        DispatchQueue.main.async { self.syncPageChrome() } // the view switch moved
    }

    func paintLive() {
        guard let liveLabel else { return }
        let offline = liveState == false
        let color: NSColor = offline ? NSColor(srgbRed: 0.80, green: 0.26, blue: 0.27, alpha: 1) : .tertiaryLabelColor
        let s = NSMutableAttributedString(string: "● ", attributes: [.foregroundColor: color])
        s.append(NSAttributedString(string: offline ? "Offline" : "Connecting…",
                                    attributes: [.foregroundColor: NSColor.secondaryLabelColor]))
        liveLabel.attributedStringValue = s
        liveLabel.toolTip = offline ? "The local server isn't answering. The app restarts it on its own." : nil
    }

    // MARK: sound

    var soundOn: Bool { defaults.bool(forKey: "soundOn") }

    @objc func toggleSound() {
        defaults.set(!soundOn, forKey: "soundOn")
        paintSound()
        if soundOn { NSSound(named: "Glass")?.play() }
    }

    // The speaker with waves is wider than the crossed-out one. Both are drawn centered in
    // the same box, so turning the sound on or off never resizes the toolbar button and
    // the view switch and search next to it stay put.
    func soundIcon(on: Bool, description: String) -> NSImage? {
        let config = NSImage.SymbolConfiguration(pointSize: 15, weight: .regular)
        let symbols = ["speaker.wave.2", "speaker.slash"].compactMap {
            NSImage(systemSymbolName: $0, accessibilityDescription: nil)?.withSymbolConfiguration(config)
        }
        guard symbols.count == 2 else { return nil }
        let box = NSSize(width: ceil(symbols.map(\.size.width).max()!), height: ceil(symbols.map(\.size.height).max()!))
        let symbol = symbols[on ? 0 : 1]
        let image = NSImage(size: box, flipped: false) { rect in
            symbol.draw(in: NSRect(x: (rect.width - symbol.size.width) / 2, y: (rect.height - symbol.size.height) / 2,
                                   width: symbol.size.width, height: symbol.size.height))
            return true
        }
        image.isTemplate = true // the toolbar tints it like any other icon
        image.accessibilityDescription = description
        return image
    }

    func paintSound() {
        let text = soundOn ? "Turn Off Alert Sound" : "Turn On Alert Sound"
        // A speaker, not a bell: on a Mac a bell reads as notifications, and this is sound.
        soundItem?.image = soundIcon(on: soundOn, description: text)
        soundItem?.toolTip = text
        statusSoundItem?.state = soundOn ? .on : .off
        settingsSound?.state = soundOn ? .on : .off
    }

    // What the page tells the app:
    //   alert    a session started needing you: the system sound, if it's on, and a
    //            spoken note for VoiceOver with what changed
    //   view     it switched views itself (its empty state links to All Sessions)
    //   menu     a right click on a session: the app's own menu for it
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        if body["alert"] != nil, soundOn { NSSound(named: "Glass")?.play() }
        if let text = body["announce"] as? String, !text.isEmpty {
            NSAccessibility.post(element: window as Any, notification: .announcementRequested, userInfo: [
                .announcement: text, .priority: NSAccessibilityPriorityLevel.high.rawValue])
        }
        if let v = body["view"] as? String, let i = views.firstIndex(of: v) { viewSwitch?.selectedSegment = i }
        if let info = body["menu"] as? [String: Any] { showSessionMenu(info) }
        if body["update"] != nil { downloadUpdate() }
        if let holes = body["holes"] as? [[Double]] {
            web.holes = holes.compactMap { $0.count == 4 ? CGRect(x: $0[0], y: $0[1], width: $0[2], height: $0[3]) : nil }
        }
    }

    // MARK: session menu

    // A session card: open it, copy its title, show its project. A scheduled task's card
    // also shows the task's own file; its "open" is the task's last run, if it ran.
    func showSessionMenu(_ info: [String: Any]) {
        let sid = info["sid"] as? String ?? ""
        let title = info["title"] as? String ?? ""
        let cwd = info["cwd"] as? String ?? ""
        let file = info["file"] as? String ?? ""
        let isTask = info["file"] != nil
        let exists = { (path: String) in !path.isEmpty && FileManager.default.fileExists(atPath: path) }
        let open = item(isTask ? "Open Last Run in Claude" : "Open in Claude", #selector(openSession(_:)), "")
        open.representedObject = sid
        if sid.isEmpty { open.action = nil } // never ran: dimmed
        let copy = item(isTask ? "Copy Name" : "Copy Title", #selector(copyTitle(_:)), "")
        copy.representedObject = title
        let reveal = item("Reveal Project in Finder", #selector(revealProject(_:)), "")
        reveal.representedObject = cwd
        if !exists(cwd) { reveal.action = nil }
        var items: [NSMenuItem] = [open, .separator(), copy, reveal]
        if isTask {
            let task = item("Reveal Task in Finder", #selector(revealProject(_:)), "")
            task.representedObject = file
            if !exists(file) { task.action = nil }
            items.append(task)
        }
        let menu = NSMenu()
        menu.items = items
        menu.popUp(positioning: nil, at: web.convert(window.mouseLocationOutsideOfEventStream, from: nil), in: web)
    }

    @objc func openSession(_ sender: NSMenuItem) {
        guard let sid = sender.representedObject as? String,
              let path = sid.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed),
              let url = URL(string: "http://127.0.0.1:\(port)/api/open/\(path)") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("1", forHTTPHeaderField: "x-csm")
        URLSession.shared.dataTask(with: req).resume()
    }

    @objc func copyTitle(_ sender: NSMenuItem) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(sender.representedObject as? String ?? "", forType: .string)
    }

    @objc func revealProject(_ sender: NSMenuItem) {
        guard let path = sender.representedObject as? String, !path.isEmpty else { return }
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
    }

    // MARK: views and search

    // The page's names for the three views, in the switch's order.
    let views = ["week", "history", "scheduled"]

    @objc func viewChanged(_ sender: NSSegmentedControl) {
        callPage("csm.setView", views[max(0, min(views.count - 1, sender.selectedSegment))])
    }

    @objc func searchChanged(_ sender: NSSearchField) {
        callPage("csm.search", sender.stringValue)
        if !sender.stringValue.isEmpty { viewSwitch?.selectedSegment = 1 } // results live in All Sessions
    }

    // Calls a page function with one string, safely quoted as JSON.
    func callPage(_ function: String, _ value: String) {
        guard pageLoaded,
              let data = try? JSONSerialization.data(withJSONObject: value, options: .fragmentsAllowed),
              let arg = String(data: data, encoding: .utf8) else { return }
        web.evaluateJavaScript("\(function)(\(arg))", completionHandler: nil)
    }

    @objc func showWeek() {
        viewSwitch?.selectedSegment = 0
        callPage("csm.setView", "week")
    }

    @objc func showHistory() {
        viewSwitch?.selectedSegment = 1
        callPage("csm.setView", "history")
    }

    @objc func showScheduled() {
        viewSwitch?.selectedSegment = 2
        callPage("csm.setView", "scheduled")
    }

    @objc func focusSearch() {
        showWindow()
        if let field = searchItem?.searchField { window.makeFirstResponder(field) }
    }

    // MARK: size

    // A 4K screen at 1x makes 14 px text tiny, so dense screens get 150% unless you pick
    // a size. The longer side counts, so a 4K screen turned vertical counts too.
    func autoZoom(for screen: NSScreen?) -> CGFloat {
        guard let s = screen else { return 1 }
        return s.backingScaleFactor < 1.5 && max(s.frame.width, s.frame.height) >= 3000 ? 1.5 : 1
    }

    var zoom: CGFloat {
        let chosen = defaults.double(forKey: "zoom")
        return chosen > 0 ? CGFloat(chosen) : autoZoom(for: window?.screen ?? NSScreen.main)
    }

    let steps: [Double] = [1, 1.25, 1.5, 1.75, 2]

    func applyZoom() {
        web.pageZoom = zoom
        syncPageChrome()
        rebuildSizeMenus()
        refreshSettings()
    }

    @objc func zoomIn() { stepZoom(+1) }
    @objc func zoomOut() { stepZoom(-1) }
    @objc func actualSize() { defaults.set(0, forKey: "zoom"); applyZoom() }

    func stepZoom(_ dir: Int) {
        let now = Double(zoom)
        let next = dir > 0 ? steps.first { $0 > now + 0.01 } : steps.last { $0 < now - 0.01 }
        if let next {
            defaults.set(next, forKey: "zoom")
            applyZoom()
        }
    }

    @objc func chooseSize(_ sender: NSMenuItem) {
        defaults.set(sender.representedObject as? Double ?? 0, forKey: "zoom")
        applyZoom()
    }

    func sizeItems() -> [NSMenuItem] {
        let chosen = defaults.double(forKey: "zoom")
        let auto = Int((autoZoom(for: window?.screen ?? NSScreen.main) * 100).rounded())
        return ([0.0] + steps).map { value in
            let title = value == 0 ? "Automatic (\(auto)% here)" : "\(Int(value * 100))%"
            let i = item(title, #selector(chooseSize(_:)), "")
            i.representedObject = value
            i.state = chosen == value ? .on : .off
            return i
        }
    }

    func rebuildSizeMenus() {
        for menu in sizeMenus { menu.items = sizeItems() }
    }

    // MARK: page

    // Load the page once the server answers; the page reconnects by itself after that.
    func loadWhenReady() {
        var req = URLRequest(url: stateURL)
        req.timeoutInterval = 1
        URLSession.shared.dataTask(with: req) { _, response, _ in
            let ok = (response as? HTTPURLResponse)?.statusCode == 200
            Task { @MainActor in
                if ok {
                    self.web.load(URLRequest(url: stripURL))
                } else {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.loadWhenReady() }
                }
            }
        }.resume()
    }

    nonisolated func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        Task { @MainActor in
            self.pageLoaded = true
            self.syncPageChrome()
            if let r = self.availableUpdate { self.noteUpdate(r) } // a reloaded page shows it again
        }
    }

    nonisolated func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        Task { @MainActor in
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self.loadWhenReady() }
        }
    }

    nonisolated func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        Task { @MainActor in self.loadWhenReady() }
    }

    @objc func reloadPage() { loadWhenReady() }

    @objc func openBrowser() {
        NSWorkspace.shared.open(URL(string: "http://127.0.0.1:\(port)")!)
    }

    // MARK: menus

    func item(_ title: String, _ action: Selector?, _ key: String, _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
        let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
        i.keyEquivalentModifierMask = mods
        if let action, responds(to: action) { i.target = self }
        return i
    }

    // The menus every Mac app has. Edit has no target, so its commands go to whatever has
    // the focus: the search field, for one.
    func buildMainMenu() {
        let main = NSMenu()

        let services = NSMenuItem(title: "Services", action: nil, keyEquivalent: "")
        services.submenu = NSMenu()
        NSApp.servicesMenu = services.submenu
        let appMenu = NSMenu()
        appMenu.items = [
            item("About \(appName)", #selector(NSApplication.orderFrontStandardAboutPanel(_:)), ""),
            item("Check for Updates…", #selector(checkForUpdates), ""),
            .separator(),
            item("Settings…", #selector(showSettings), ","),
            .separator(),
            services,
            .separator(),
            item("Hide \(appName)", #selector(NSApplication.hide(_:)), "h"),
            item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
            item("Show All", #selector(NSApplication.unhideAllApplications(_:)), ""),
            .separator(),
            item("Quit \(appName)", #selector(NSApplication.terminate(_:)), "q"),
        ]

        let viewMenu = NSMenu(title: "View")
        let size = NSMenuItem(title: "Size", action: nil, keyEquivalent: "")
        let sizeMenu = NSMenu()
        size.submenu = sizeMenu
        sizeMenus.append(sizeMenu)
        viewMenu.items = [
            item("Last 7 Days", #selector(showWeek), "1"),
            item("All Sessions", #selector(showHistory), "2"),
            item("Scheduled", #selector(showScheduled), "3"),
            .separator(),
            item("Actual Size", #selector(actualSize), "0"),
            item("Zoom In", #selector(zoomIn), "="),
            item("Zoom Out", #selector(zoomOut), "-"),
            size,
            .separator(),
            item("Reload", #selector(reloadPage), "r"),
            item("Open in Browser", #selector(openBrowser), "o"),
            .separator(),
            item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
        ]

        let fileMenu = NSMenu(title: "File")
        fileMenu.items = [item("Close Window", #selector(NSWindow.performClose(_:)), "w")]

        let editMenu = NSMenu(title: "Edit")
        editMenu.items = [
            item("Undo", Selector(("undo:")), "z"),
            item("Redo", Selector(("redo:")), "z", [.command, .shift]),
            .separator(),
            item("Cut", #selector(NSText.cut(_:)), "x"),
            item("Copy", #selector(NSText.copy(_:)), "c"),
            item("Paste", #selector(NSText.paste(_:)), "v"),
            item("Select All", #selector(NSText.selectAll(_:)), "a"),
            .separator(),
            item("Find…", #selector(focusSearch), "f"),
        ]

        let windowMenu = NSMenu(title: "Window")
        windowMenu.items = [
            item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
            item("Zoom", #selector(NSWindow.performZoom(_:)), ""),
            .separator(),
            item("Bring All to Front", #selector(NSApplication.arrangeInFront(_:)), ""),
        ]

        let helpMenu = NSMenu(title: "Help")
        helpMenu.items = [item("\(appName) Help", #selector(openHelp), "?")]

        for (title, submenu) in [(appName, appMenu), ("File", fileMenu), ("Edit", editMenu), ("View", viewMenu),
                                 ("Window", windowMenu), ("Help", helpMenu)] {
            let top = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            top.submenu = submenu
            main.addItem(top)
        }
        NSApp.mainMenu = main
        NSApp.windowsMenu = windowMenu
        NSApp.helpMenu = helpMenu
    }

    @objc func openHelp() {
        NSWorkspace.shared.open(URL(string: "https://github.com/creative-context/claude-session-monitor#readme")!)
    }

    // The menu bar item: how many sessions need you, in orange, and a few shortcuts.
    func buildStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            button.image = NSImage(systemSymbolName: "rectangle.topthird.inset.filled", accessibilityDescription: appName)
            button.image?.isTemplate = true
            button.imagePosition = .imageLeading
            button.toolTip = appName
        }
        let menu = NSMenu()
        statusSoundItem = item("Alert Sound", #selector(toggleSound), "")
        loginItem = item("Open at Login", #selector(toggleLogin), "")
        statusUpdateItem = item("Update Available…", #selector(downloadUpdate), "")
        statusUpdateItem.isHidden = true // shown when a newer version is out
        menu.items = [
            item("Show Window", #selector(showWindowAction), ""),
            statusUpdateItem,
            .separator(),
            statusSoundItem, loginItem,
            .separator(),
            item("Settings…", #selector(showSettings), ""),
            item("Check for Updates…", #selector(checkForUpdates), ""),
            item("Open in Browser", #selector(openBrowser), ""),
            .separator(),
            item("Quit \(appName)", #selector(NSApplication.terminate(_:)), "q"),
        ]
        statusItem.menu = menu
        rebuildSizeMenus()
        paintSound()
        refreshLoginItem()
    }

    @objc func showWindowAction() { showWindow() }

    // The count of what needs you comes from the server, the same number the window
    // shows: blocked on you, or a question or an error from the last day. In orange.
    func refreshStatus() {
        URLSession.shared.dataTask(with: stateURL) { data, _, _ in
            var waiting = 0
            var working = 0
            if let data, let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let sessions = json["sessions"] as? [[String: Any]] {
                waiting = json["needs"] as? Int ?? 0
                working = sessions.filter { $0["status"] as? String == "working" }.count
            }
            let ok = data != nil
            Task { @MainActor in
                self.setLive(ok)
                NSApp.dockTile.badgeLabel = waiting > 0 ? "\(waiting)" : nil
                guard let button = self.statusItem?.button else { return }
                button.attributedTitle = waiting > 0
                    ? NSAttributedString(string: " \(waiting)", attributes: [
                        .foregroundColor: NSColor(srgbRed: 0.98, green: 0.55, blue: 0, alpha: 1),
                        .font: NSFont.monospacedDigitSystemFont(ofSize: 13, weight: .semibold)])
                    : NSAttributedString(string: "")
                let needs = waiting == 1 ? "1 needs you" : "\(waiting) need you" // sessions, and tasks that can't run
                button.toolTip = ok ? "\(appName)\n\(needs) · \(working) working" : "\(appName): server offline"
            }
        }.resume()
    }

    // MARK: login item

    @objc func toggleLogin() {
        setLogin(SMAppService.mainApp.status != .enabled)
    }

    func setLogin(_ on: Bool) {
        do {
            if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
        } catch {
            NSLog("\(appName): login item: \(error)")
        }
        refreshLoginItem()
    }

    func refreshLoginItem() {
        let status = SMAppService.mainApp.status
        loginItem?.state = status == .enabled ? .on : .off
        loginItem?.title = status == .requiresApproval ? "Open at Login (approve in System Settings)" : "Open at Login"
        settingsLogin?.state = status == .enabled ? .on : .off
    }

    // MARK: settings

    // One small window with the three choices, also in the menus: the alert sound, opening
    // at login and the text size.
    @objc func showSettings() {
        if settingsWindow == nil { buildSettings() }
        refreshSettings()
        settingsWindow?.makeKeyAndOrderFront(nil)
        NSApp.activate()
    }

    func buildSettings() {
        let label = { (text: String) in NSTextField(labelWithString: text) }
        let sound = NSButton(checkboxWithTitle: "Play a sound when a session needs you", target: self, action: #selector(toggleSound))
        let login = NSButton(checkboxWithTitle: "Open at login", target: self, action: #selector(toggleLogin))
        let size = NSPopUpButton(frame: .zero, pullsDown: false)
        let hookState = NSTextField(labelWithString: "")
        hookState.textColor = .secondaryLabelColor
        let hookButton = NSButton(title: "", target: self, action: #selector(toggleHook))
        hookButton.bezelStyle = .rounded
        let hookRow = NSStackView(views: [hookButton, hookState])
        hookRow.spacing = 8
        let updates = NSButton(checkboxWithTitle: "Check for updates automatically", target: self, action: #selector(toggleUpdates))
        let grid = NSGridView(views: [
            [label("Alerts:"), sound],
            [label("Startup:"), login],
            [label("Text size:"), size],
            [label("Claude Code:"), hookRow],
            [label("Updates:"), updates],
        ])
        grid.column(at: 0).xPlacement = .trailing
        grid.rowAlignment = .firstBaseline
        grid.rowSpacing = 14
        grid.columnSpacing = 8
        grid.translatesAutoresizingMaskIntoConstraints = false

        let w = NSWindow(contentRect: .zero, styleMask: [.titled, .closable], backing: .buffered, defer: false)
        w.title = "Settings"
        w.appearance = NSAppearance(named: .darkAqua)
        w.isReleasedWhenClosed = false
        let content = NSView()
        content.addSubview(grid)
        NSLayoutConstraint.activate([
            grid.topAnchor.constraint(equalTo: content.topAnchor, constant: 24),
            grid.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -24),
            grid.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 32),
            grid.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -32),
        ])
        w.contentView = content
        w.setContentSize(content.fittingSize) // size it before centering
        w.center()
        settingsWindow = w
        settingsSound = sound
        settingsLogin = login
        settingsSize = size
        settingsHookState = hookState
        settingsHookButton = hookButton
        settingsUpdates = updates
    }

    func refreshSettings() {
        guard let size = settingsSize else { return }
        let menu = NSMenu()
        menu.items = sizeItems()
        size.menu = menu
        if let on = menu.items.first(where: { $0.state == .on }) { size.select(on) }
        settingsSound?.state = soundOn ? .on : .off
        refreshLoginItem()
        let on = hookInstalled
        settingsHookState?.stringValue = on ? "Connected: the hook is in Claude Code's settings" : "Not connected: no sessions show up"
        settingsHookButton?.title = on ? "Remove Hook" : "Install Hook"
        settingsUpdates?.state = defaults.bool(forKey: "checkUpdates") ? .on : .off
        settingsWindow?.setContentSize(settingsWindow?.contentView?.fittingSize ?? .zero)
    }

    // MARK: updates

    // Asks GitHub for the newest release. It sends nothing about you or your sessions:
    // a plain request for a public page, which you can turn off in Settings.
    var releasesFeed: URL {
        if let s = defaults.string(forKey: "updateFeedURL"), let u = URL(string: s) { return u } // for testing
        return URL(string: "https://api.github.com/repos/creative-context/claude-session-monitor/releases/latest")!
    }
    let releasesHome = "https://github.com/creative-context/claude-session-monitor/releases"
    var currentVersion: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0" }

    // "v1.2.3-beta.2" → [1, 2, 3]: a pre-release or build suffix is not part of the number.
    nonisolated static func versionParts(_ v: String) -> [Int] {
        let core = v.trimmingCharacters(in: CharacterSet(charactersIn: "vV ")).split(whereSeparator: { $0 == "-" || $0 == "+" }).first ?? ""
        return core.split(separator: ".").map { Int($0.prefix { $0.isNumber }) ?? 0 }
    }

    // "v0.4.0" is newer than "0.3.0"; "0.3" equals "0.3.0".
    nonisolated static func isNewer(_ a: String, than b: String) -> Bool {
        let x = versionParts(a), y = versionParts(b)
        for i in 0..<max(x.count, y.count) {
            let p = i < x.count ? x[i] : 0, q = i < y.count ? y[i] : 0
            if p != q { return p > q }
        }
        return false
    }

    func fetchLatestRelease(_ done: @escaping @MainActor (Result<Release, UpdateError>) -> Void) {
        var req = URLRequest(url: releasesFeed)
        req.timeoutInterval = 15
        req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        req.setValue("ClaudeSessionMonitor/\(currentVersion)", forHTTPHeaderField: "User-Agent")
        let home = releasesHome
        URLSession.shared.dataTask(with: req) { data, response, error in
            let result: Result<Release, UpdateError>
            if let error {
                result = .failure(.network(error.localizedDescription))
            } else if let http = response as? HTTPURLResponse, http.statusCode != 200 {
                result = .failure(.status(http.statusCode))
            } else if let data, let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let tag = j["tag_name"] as? String {
                // Only ever open this project's own releases, whatever the reply says.
                let html = j["html_url"] as? String ?? ""
                let page = html.hasPrefix(home + "/") ? html : home + "/latest"
                result = .success(Release(version: tag, page: page))
            } else {
                result = .failure(.unreadable)
            }
            Task { @MainActor in done(result) }
        }.resume()
    }

    // The menu item: always answers, up to date or not.
    @objc func checkForUpdates() {
        fetchLatestRelease { result in
            switch result {
            case .success(let r) where Self.isNewer(r.version, than: self.currentVersion):
                self.noteUpdate(r)
                self.offerUpdate(r)
            case .success(let r):
                let latest = Self.versionParts(r.version).map(String.init).joined(separator: ".")
                let alert = NSAlert()
                alert.messageText = "You're up to date"
                alert.informativeText = Self.isNewer(self.currentVersion, than: r.version)
                    ? "You have \(self.currentVersion), newer than the latest release, \(latest)."
                    : "\(appName) \(self.currentVersion) is the newest version."
                alert.runModal()
            case .failure(let e):
                self.failed("Couldn't check for updates", e.text)
            }
        }
    }

    // At launch and once a day: silent unless there is something new.
    func checkQuietly() {
        guard defaults.bool(forKey: "checkUpdates") else { return }
        fetchLatestRelease { result in
            guard case .success(let r) = result, Self.isNewer(r.version, than: self.currentVersion) else { return }
            self.noteUpdate(r)
            if self.defaults.string(forKey: "notifiedVersion") != r.version {
                self.defaults.set(r.version, forKey: "notifiedVersion")
                self.notifyUpdate(r)
            }
        }
    }

    // Shows a newer version in the menu bar item's menu and as a banner in the window.
    func noteUpdate(_ r: Release) {
        availableUpdate = r
        let v = Self.versionParts(r.version).map(String.init).joined(separator: ".")
        statusUpdateItem?.title = "Update to \(v)…"
        statusUpdateItem?.isHidden = false
        callPage("csm.updateAvailable", v)
    }

    func offerUpdate(_ r: Release) {
        let v = Self.versionParts(r.version).map(String.init).joined(separator: ".")
        let alert = NSAlert()
        alert.messageText = "\(appName) \(v) is available"
        alert.informativeText = "You have \(currentVersion). Download the new version from GitHub, quit this one, and put the new one in Applications in its place."
        alert.addButton(withTitle: "Download")
        alert.addButton(withTitle: "Later")
        if alert.runModal() == .alertFirstButtonReturn { downloadUpdate() }
    }

    @objc func downloadUpdate() {
        if let url = URL(string: availableUpdate?.page ?? releasesHome + "/latest") { NSWorkspace.shared.open(url) }
    }

    // A macOS notification, once per new version. If notifications are off for the app,
    // the banner in the window still says it.
    func notifyUpdate(_ r: Release) {
        let v = Self.versionParts(r.version).map(String.init).joined(separator: ".")
        let page = r.page
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, _ in
            guard granted else { return }
            let content = UNMutableNotificationContent()
            content.title = "\(appName) \(v) is available"
            content.body = "Click to download it from GitHub."
            content.userInfo = ["page": page]
            UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "update-\(v)", content: content, trigger: nil))
        }
    }

    @objc func toggleUpdates() {
        defaults.set(!defaults.bool(forKey: "checkUpdates"), forKey: "checkUpdates")
        refreshSettings()
        if defaults.bool(forKey: "checkUpdates") { checkQuietly() }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                            withCompletionHandler completionHandler: @escaping () -> Void) {
        let page = response.notification.request.content.userInfo["page"] as? String
        Task { @MainActor in
            if let page, page.hasPrefix(self.releasesHome), let url = URL(string: page) { NSWorkspace.shared.open(url) }
            completionHandler()
        }
    }

    // Show it even while the app is in front.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                            withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }

    // MARK: requirements and the hook

    // Says what is missing before anything else, since nothing works without it.
    // Returns true when it showed something.
    func checkRequirements() -> Bool {
        var missing: [String] = []
        if bunPath == nil { missing.append("Bun runs the app's local server. Install it from bun.sh.") }
        if jqPath == nil { missing.append("jq is what the Claude Code hook uses. Install it with: brew install jq") }
        if serverDir == nil { missing.append("The server files are missing from the app. Download it again.") }
        guard !missing.isEmpty else { return false }
        let alert = NSAlert()
        alert.messageText = "\(appName) needs a bit more"
        alert.informativeText = missing.joined(separator: "\n\n") + "\n\nThen open the app again."
        alert.addButton(withTitle: "OK")
        if bunPath == nil { alert.addButton(withTitle: "Open bun.sh") }
        if alert.runModal() == .alertSecondButtonReturn { NSWorkspace.shared.open(URL(string: "https://bun.sh")!) }
        return true
    }

    var claudeSettings: URL { URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(".claude/settings.json") }
    // A copy of the hook outside the app, so moving or updating the app never breaks it.
    var hookDir: URL { URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(".claude-session-monitor/hooks") }
    var hookFile: URL { hookDir.appendingPathComponent("session-hook.sh") }

    var settingsText: String { (try? String(contentsOf: claudeSettings, encoding: .utf8)) ?? "" }
    var hookInstalled: Bool { settingsText.contains("session-hook.sh") }

    func copyHook() throws {
        guard let source = serverDir?.appendingPathComponent("hooks") else { throw CocoaError(.fileNoSuchFile) }
        let fm = FileManager.default
        try fm.createDirectory(at: hookDir, withIntermediateDirectories: true)
        for name in ["session-hook.sh", "event.jq"] {
            let from = source.appendingPathComponent(name)
            let to = hookDir.appendingPathComponent(name)
            if fm.contentsEqual(atPath: from.path, andPath: to.path) { continue }
            try? fm.removeItem(at: to)
            try fm.copyItem(at: from, to: to)
        }
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: hookFile.path)
    }

    // When Claude Code uses the app's copy of the hook, a newer app brings a newer hook.
    func keepHookCurrent() {
        if settingsText.contains(hookFile.path) { try? copyHook() }
    }

    // Runs the bundled installer, which backs up settings.json and touches only its own entries.
    func runInstaller(_ args: [String]) -> Bool {
        guard let bun = bunPath, let dir = serverDir else { return false }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: bun)
        p.arguments = ["install-hooks.ts"] + args
        p.currentDirectoryURL = dir
        do {
            try p.run()
            p.waitUntilExit()
            return p.terminationStatus == 0
        } catch {
            return false
        }
    }

    // First launch without the hook: ask once. Settings can install it any time.
    func offerHook() {
        guard !hookInstalled, bunPath != nil, !defaults.bool(forKey: "hookOffered") else { return }
        defaults.set(true, forKey: "hookOffered")
        let alert = NSAlert()
        alert.messageText = "Connect Claude Code?"
        alert.informativeText = "To see your sessions, the app adds a small hook to Claude Code's settings (~/.claude/settings.json). It saves a copy of the file first and changes nothing else. You can remove it in Settings."
        alert.addButton(withTitle: "Install Hook")
        alert.addButton(withTitle: "Not Now")
        if alert.runModal() == .alertFirstButtonReturn { installHook() }
    }

    @objc func toggleHook() {
        if hookInstalled { removeHook() } else { installHook() }
    }

    func installHook() {
        var ok = false
        do {
            try copyHook()
            ok = runInstaller(["--hook", hookFile.path])
        } catch {}
        refreshSettings()
        if !ok { failed("Couldn't install the hook", "Claude Code's settings were left as they were.") }
    }

    func removeHook() {
        let ok = runInstaller(["--uninstall"])
        refreshSettings()
        if !ok { failed("Couldn't remove the hook", "Claude Code's settings were left as they were.") }
    }

    func failed(_ title: String, _ text: String) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = title
        alert.informativeText = text
        alert.runModal()
    }
}

MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.regular) // a Dock icon and Cmd-Tab, like any app
    app.run()
}
