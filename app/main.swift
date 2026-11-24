// Claude Session Monitor: a Mac app that shows your Claude Code sessions in a regular
// window and keeps its local server running.
//
// The window is a standard macOS window with a transparent title bar: the system's own
// close, minimize and zoom buttons, resize edges, dragging, Dock icon and Cmd-Tab. The
// page (http://127.0.0.1:4747/?embed) fills it and reflows to any size, like a web page.
// The toolbar holds the Pinned and Most active filters, the view switch, search and the sound switch, plus the connection
// status while the server doesn't answer. A menu bar item and the Dock icon show how
// many sessions need you, as the page reports it. A card waiting on you can take a
// spoken answer: the app listens and turns it into words on this Mac (Dictation).

import AppKit
import AVFoundation
import ServiceManagement
import Speech
import UserNotifications
import WebKit

let port = 4747
let stripURL = URL(string: "http://127.0.0.1:\(port)/?embed")!
let stateURL = URL(string: "http://127.0.0.1:\(port)/api/state")!
let appName = "Claude Session Monitor"

// Dark surfaces: the window paints the body color so nothing shows through.
let pageBody = NSColor(srgbRed: 0x03 / 255, green: 0x03 / 255, blue: 0x04 / 255, alpha: 1) // the page's --color-background-body

extension NSToolbarItem.Identifier {
    static let pinned = NSToolbarItem.Identifier("pinned")
    static let active = NSToolbarItem.Identifier("active")
    static let view = NSToolbarItem.Identifier("view")
    static let search = NSToolbarItem.Identifier("search")
    static let live = NSToolbarItem.Identifier("live")
    static let sound = NSToolbarItem.Identifier("sound")
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
    var soundButton: NSButton?
    var viewSwitch: NSSegmentedControl?
    var pinnedButton: NSButton?
    // The page owns the Pinned filter; these mirror what it last reported, so the button can
    // be rebuilt (after the strip) in the same state.
    var pinnedOn = false
    var pinnedCount = 0
    var pinnedBeforeStrip = false // the filter was on when the strip came: it comes back with the toolbar
    var activeButton: NSButton?
    // The same for Most active: the page owns the filter, the app mirrors it.
    var activeOn = false
    var activeBeforeStrip = false
    var toolbarStripped = false // the strip: the toolbar's buttons step aside
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
    var settingsPhrases: [String: NSTextField] = [:] // Send by voice, one field per dictation language
    var settingsKeepPhrase: NSButton?
    var settingsCues: NSButton?
    var statusUpdateItem: NSMenuItem!
    var needsMenuItems: [NSMenuItem] = [] // what needs you, at the top of the menu bar menu
    var needsMenuKey = ""
    var availableUpdate: Release?
    var sizeMenus: [NSMenu] = []
    var languageMenus: [NSMenu] = [] // Dictation Language, in the Edit menu and the menu bar menu
    // A spoken answer on a card: the app hears it, the page shows the words.
    lazy var dictation = Dictation { [weak self] in self?.sendDictation($0) }
    // The local server: run, replaced and restarted by the family's app kit (ShellKit.swift).
    var keeper: ServerKeeper!
    var pageLoaded = false
    var pageSendsStatus = false // the loaded page posts its counts; until then, poll
    var lastStatusAt = Date.distantPast

    // MARK: launch

    func applicationDidFinishLaunching(_ notification: Notification) {
        ShellLog.appName = appName
        ShellLog.path = Self.logPath
        keeper = ServerKeeper(.init(port: port, version: currentVersion, versionEnv: "CSM_VERSION", parentEnv: "CSM_PARENT_PID"))
        keeper.onExit = { [weak self] in self?.setLive(false) }
        keeper.launch()
        buildMainMenu()
        buildWindow()
        buildStatusItem()
        // Open at Login is off until you turn it on in the menu bar item's menu.
        // The page tells the app its counts as they change; this is the fallback.
        let tick = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in
            Task { @MainActor in self.statusTick() }
        }
        tick.tolerance = 0.5
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { _ in
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
        dictation.cancel() // the microphone goes off with the app
        keeper.terminate()
    }

    // Clicking the Dock icon (or opening the app again) brings the window back.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showWindow()
        return false
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    // MARK: server

    // The server, bundled into server.js, the page and the hook travel inside the app (build.sh puts them there).
    var serverDir: URL? { ServerKeeper.serverDir }
    var bunPath: String? { ServerKeeper.bunPath }

    // The hook needs jq; recent macOS ships it.
    var jqPath: String? {
        ["/usr/bin/jq", "/opt/homebrew/bin/jq", "/usr/local/bin/jq"].first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    // The server's log, which the app also writes to (ShellLog).
    nonisolated static var logPath: String { "\(NSHomeDirectory())/.claude-session-monitor/server.log" }
    nonisolated static func log(_ text: String) { ShellLog.write(text) }

    // MARK: window

    func buildWindow() {
        window = PageWindow(
            contentRect: NSRect(x: 0, y: 0, width: 960, height: 420),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false)
        window.title = appName
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.appearance = NSAppearance(named: .darkAqua) // the look is dark only
        window.backgroundColor = pageBody
        window.isReleasedWhenClosed = false
        // Down to a sliver of the screen: under 640 the page turns compact and the view
        // switch shows only its icons; under 300 it's a strip of just the essentials, and
        // the toolbar's items that don't fit go to its overflow menu.
        window.minSize = NSSize(width: 171, height: 260)
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
        config.userContentController.add(self, name: "dictate") // a card's microphone: start, stop, cancel
        web = PageView(frame: .zero, configuration: config)
        // WebKit doesn't tell the page when the pointer leaves an inactive window, and it
        // replays the last pointer position on layout changes, so the related-sessions
        // spotlight could stay on or turn on by itself: the view tells the page.
        web.pointerFunction = "window.csm?.pointer"
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
        dictation.stop() // no listening with the window away; the words wait on the card
        window.orderOut(nil)
        return false
    }

    func windowDidResize(_ notification: Notification) {
        fitViewSwitch()
        syncPageChrome()
    }

    // The view switch drops its words in a narrow window and keeps them as tooltips. In the
    // strip (under 300 of the page's pixels) the toolbar gives up its items, so the title bar
    // keeps the needs-you count and the window can get that narrow; the views stay on ⌘1–⌘3
    // and in the View menu. They come back, on the same view, when the window widens.
    static let viewNames = ["Last 7 Days", "All Sessions", "Scheduled"]
    func fitViewSwitch() {
        guard let window, let toolbar = window.toolbar else { return }
        let width = window.frame.width / zoom
        let strip = width < 300
        if #available(macOS 15.0, *) {
            // Hidden, not removed: an empty toolbar turns into an opaque bar over the page.
            for item in toolbar.items where item.isHidden != strip { item.isHidden = strip }
        } else if strip, !toolbar.items.isEmpty {
            while !toolbar.items.isEmpty { toolbar.removeItem(at: 0) }
        } else if !strip, toolbar.items.isEmpty {
            for (i, id) in toolbarDefaultItemIdentifiers(toolbar).enumerated() { toolbar.insertItem(withItemIdentifier: id, at: i) }
        }
        // The Pinned filter leaves with the toolbar: in the strip nothing would show it's on, and
        // it would hide a session that needs you there. It comes back on with the toolbar.
        if strip != toolbarStripped {
            if strip, pinnedOn { pinnedBeforeStrip = true; callPage("csm.pinnedOnly", false) }
            else if !strip, pinnedBeforeStrip { pinnedBeforeStrip = false; callPage("csm.pinnedOnly", true) }
            if strip, activeOn { activeBeforeStrip = true; callPage("csm.activeOnly", false) }
            else if !strip, activeBeforeStrip { activeBeforeStrip = false; callPage("csm.activeOnly", true) }
        }
        toolbarStripped = strip
        // In full screen or Split View, an empty toolbar would stay on as a bare bar above the
        // header: the strip goes without it.
        let wantBar = !(strip && window.styleMask.contains(.fullScreen))
        if toolbar.isVisible != wantBar { toolbar.isVisible = wantBar }
        let narrow = width < 640 // the page turns compact at the same width
        if narrow != pinnedCompact { pinnedCompact = narrow; paintPinned(); paintActive() }
        guard let seg = viewSwitch, seg.window != nil else { return }
        for (i, name) in Self.viewNames.enumerated() {
            let want = narrow ? "" : name
            if seg.label(forSegment: i) != want { seg.setLabel(want, forSegment: i) }
            seg.setToolTip(name, forSegment: i)
        }
    }
    func windowDidChangeScreen(_ notification: Notification) { applyZoom() }
    func windowDidChangeBackingProperties(_ notification: Notification) { syncPageChrome() }
    // In full screen the toolbar would sit in its own gray bar above the page. It hides with
    // the menu bar instead, as in Safari, and comes down when the pointer reaches the top;
    // the views stay on ⌘1–⌘3 and in the View menu.
    func window(_ window: NSWindow, willUseFullScreenPresentationOptions proposedOptions: NSApplication.PresentationOptions = []) -> NSApplication.PresentationOptions {
        proposedOptions.union([.autoHideMenuBar, .autoHideToolbar])
    }
    func windowDidEnterFullScreen(_ notification: Notification) { fitViewSwitch(); syncPageChrome() }
    func windowDidExitFullScreen(_ notification: Notification) { fitViewSwitch(); syncPageChrome() }

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
        var top = max(4, (center - onePixel) / z - 12)
        let slot = max(0, (lightsEnd + 12) / z - 16) // the header starts 16 px in
        // In full screen, and in Split View beside another app, the toolbar can stay on as an
        // opaque bar with no window buttons: the header goes below whatever it covers.
        let covered = max(0, content.bounds.height - window.contentLayoutRect.maxY)
        if fullScreen { top = max(top, covered / z + 8) }
        // The toolbar items sit on the right; the header stops short of the first one that's
        // visible. In a narrow window they go into the toolbar's » menu, which leaves only
        // that button. Whatever the toolbar takes, the header keeps room for its first count.
        var firstItemX = content.bounds.width - (toolbarStripped ? 8 : 40)
        for item in window.toolbar?.visibleItems ?? [] {
            if let v = item.view, v.window != nil, !v.isHiddenOrHasHiddenAncestor { firstItemX = min(firstItemX, v.convert(v.bounds, to: content).minX) }
        }
        firstItemX = max(firstItemX, lightsEnd + 44 * z)
        // In full screen the toolbar sits in its own bar, not beside the header.
        let right = fullScreen ? 0 : max(0, content.bounds.width - firstItemX + 12) / z
        // Screen pixels per page pixel: the page sizes the week's days in whole ones. Its own
        // devicePixelRatio leaves the zoom out.
        let scale = z * window.backingScaleFactor
        let js = """
        (() => { const s = document.documentElement.style;
          s.setProperty('--csm-scale', '\(scale)');
          s.setProperty('--csm-chrome-top', '\(top)px');
          s.setProperty('--csm-lights-w', '\(slot)px');
          s.setProperty('--csm-chrome-right', '\(right)px');
          requestAnimationFrame(() => window.csm?.reportChrome?.()); })();
        """
        web.evaluateJavaScript(js, completionHandler: nil)
    }

    // MARK: toolbar

    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        [.flexibleSpace, .pinned, .active, .view, .search, .live, .sound]
    }

    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        [.flexibleSpace, .pinned, .active, .view, .search, .live, .sound]
    }

    func toolbar(_ toolbar: NSToolbar, itemForItemIdentifier id: NSToolbarItem.Identifier,
                 willBeInsertedIntoToolbar flag: Bool) -> NSToolbarItem? {
        switch id {
        case .pinned:
            // Show only the pinned sessions. The page keeps the filter; this button shows
            // it and flips it. Icon and count in a wide window, the icon alone in a narrow one.
            let button = NSButton(frame: .zero)
            button.bezelStyle = .toolbar
            button.setButtonType(.pushOnPushOff)
            button.target = self
            button.action = #selector(pinnedChanged(_:))
            button.toolTip = "Show only pinned sessions"
            pinnedButton = button
            paintPinned()
            let item = NSToolbarItem(itemIdentifier: id)
            item.view = button
            item.label = "Pinned"
            item.toolTip = "Show only pinned sessions"
            item.visibilityPriority = .low // in a narrow window it goes to the » menu before the views do
            return item
        case .active:
            // Show the sessions Claude worked in most. Like Pinned: the page keeps the filter.
            let button = NSButton(frame: .zero)
            button.bezelStyle = .toolbar
            button.setButtonType(.pushOnPushOff)
            button.target = self
            button.action = #selector(activeChanged(_:))
            button.toolTip = Self.activeTip
            activeButton = button
            paintActive()
            let item = NSToolbarItem(itemIdentifier: id)
            item.view = button
            item.label = "Most active"
            item.toolTip = Self.activeTip
            item.visibilityPriority = .low // goes to the » menu with Pinned, before the views do
            return item
        case .view:
            // Last 7 Days, All Sessions and Scheduled, like the view switch in Mail or Finder.
            let seg = NSSegmentedControl(labels: Self.viewNames, trackingMode: .selectOne,
                                         target: self, action: #selector(viewChanged(_:)))
            for (i, symbol) in ["square.grid.2x2", "clock.arrow.circlepath", "calendar.badge.clock"].enumerated() {
                seg.setImage(NSImage(systemSymbolName: symbol, accessibilityDescription: Self.viewNames[i]), forSegment: i)
                seg.setImageScaling(.scaleProportionallyDown, forSegment: i)
            }
            seg.selectedSegment = viewSwitch?.selectedSegment ?? 0 // the same view, when it comes back after the strip
            viewSwitch = seg
            DispatchQueue.main.async { [weak self] in self?.fitViewSwitch() } // once the window has its size
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
            // While the sound is on, the speaker takes the accent color; the button itself
            // stays plain, so it never competes with what needs you.
            let item = NSToolbarItem(itemIdentifier: id)
            item.label = "Sound"
            let button = NSButton(frame: .zero)
            button.bezelStyle = .toolbar
            button.setButtonType(.momentaryPushIn)
            button.imagePosition = .imageOnly
            button.target = self
            button.action = #selector(toggleSound)
            item.view = button
            soundItem = item
            soundButton = button
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

    // MARK: pinned

    var pinnedCompact = false // narrow window: the icon alone

    // "Pinned" with the count, the pin filled while the filter is on. Setting the state here
    // never fires the action, so the page and the button can't loop.
    func paintPinned() {
        guard let button = pinnedButton else { return }
        let symbol = pinnedOn ? "pin.fill" : "pin"
        let title = pinnedCount > 0 ? "Pinned \(pinnedCount)" : "Pinned"
        button.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)
        button.title = pinnedCompact ? "" : title
        button.imagePosition = pinnedCompact ? .imageOnly : .imageLeading
        button.state = pinnedOn ? .on : .off
        button.setAccessibilityLabel(title)
        button.setAccessibilityValue(pinnedOn ? "On" : "Off")
        button.invalidateIntrinsicContentSize()
    }

    // The page reported the filter or the count.
    func setPinned(on: Bool, count: Int) {
        // In the strip nothing shows the filter, so it isn't on there (see fitViewSwitch).
        if toolbarStripped, on { pinnedBeforeStrip = true; callPage("csm.pinnedOnly", false) }
        guard on != pinnedOn || count != pinnedCount else { return }
        pinnedOn = on
        pinnedCount = count
        paintPinned()
        DispatchQueue.main.async { self.syncPageChrome() } // the button's width changed
    }

    @objc func pinnedChanged(_ sender: NSButton) {
        pinnedOn = sender.state == .on
        paintPinned()
        callPage("csm.pinnedOnly", pinnedOn)
        DispatchQueue.main.async { self.syncPageChrome() }
    }

    // MARK: most active

    static let activeTip = "Show the sessions Claude worked in most over the last 7 days"

    // "Most active", the same pulse line on and off: the button's state shows it's on.
    func paintActive() {
        guard let button = activeButton else { return }
        button.image = NSImage(systemSymbolName: "waveform.path.ecg", accessibilityDescription: nil)
        button.title = pinnedCompact ? "" : "Most active"
        button.imagePosition = pinnedCompact ? .imageOnly : .imageLeading
        button.state = activeOn ? .on : .off
        button.setAccessibilityLabel("Most active")
        button.setAccessibilityValue(activeOn ? "On" : "Off")
        button.invalidateIntrinsicContentSize()
    }

    // The page reported the filter.
    func setActive(on: Bool) {
        // In the strip nothing shows the filter, so it isn't on there (see fitViewSwitch).
        if toolbarStripped, on { activeBeforeStrip = true; callPage("csm.activeOnly", false) }
        guard on != activeOn else { return }
        activeOn = on
        paintActive()
        DispatchQueue.main.async { self.syncPageChrome() }
    }

    @objc func activeChanged(_ sender: NSButton) {
        activeOn = sender.state == .on
        paintActive()
        callPage("csm.activeOnly", activeOn)
        DispatchQueue.main.async { self.syncPageChrome() }
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
            let at = NSRect(x: (rect.width - symbol.size.width) / 2, y: (rect.height - symbol.size.height) / 2,
                            width: symbol.size.width, height: symbol.size.height)
            symbol.draw(in: at)
            // On, the speaker is drawn in the accent color: toolbar buttons ignore a tint.
            if on {
                NSColor.controlAccentColor.set()
                at.fill(using: .sourceAtop)
            }
            return true
        }
        image.isTemplate = !on // off, the toolbar tints it like any other icon
        image.accessibilityDescription = description
        return image
    }

    func paintSound() {
        let text = soundOn ? "Turn Off Alert Sound" : "Turn On Alert Sound"
        // A speaker, not a bell: on a Mac a bell reads as notifications, and this is sound.
        soundItem?.image = soundIcon(on: soundOn, description: text)
        soundItem?.toolTip = text
        soundButton?.image = soundIcon(on: soundOn, description: text)
        soundButton?.toolTip = text
        soundButton?.setAccessibilityLabel("Alert sound")
        statusSoundItem?.state = soundOn ? .on : .off
        settingsSound?.state = soundOn ? .on : .off
    }

    // What the page tells the app:
    //   alert    a session started needing you: the system sound, if it's on, and a
    //            spoken note for VoiceOver with what changed
    //   view     it switched views itself (its empty state links to All Sessions)
    //   menu     a right click on a session: the app's own menu for it
    //   pinned   the Pinned filter ({on, count}), on load and whenever either changes
    //   active   the Most active filter ({on}), on load and whenever it changes
    //   status   what needs you and how many work, for the Dock badge and the menu bar,
    //            whenever it changes, even while the window is hidden
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        if message.name == "dictate" { return dictation.handle(body) }
        if let status = body["status"] as? [String: Any] { applyPageStatus(status) }
        if body["alert"] != nil, soundOn { NSSound(named: "Glass")?.play() }
        if let text = body["announce"] as? String, !text.isEmpty {
            NSAccessibility.post(element: window as Any, notification: .announcementRequested, userInfo: [
                .announcement: text, .priority: NSAccessibilityPriorityLevel.high.rawValue])
        }
        if let v = body["view"] as? String, let i = views.firstIndex(of: v) { viewSwitch?.selectedSegment = i }
        if let p = body["pinned"] as? [String: Any] { setPinned(on: p["on"] as? Bool ?? false, count: p["count"] as? Int ?? 0) }
        if let a = body["active"] as? [String: Any] { setActive(on: a["on"] as? Bool ?? false) }
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
        if !isTask, !sid.isEmpty {
            let pin = item(info["pinned"] as? Bool == true ? "Unpin" : "Pin", #selector(togglePin(_:)), "")
            pin.representedObject = sid
            items.insert(pin, at: 1)
        }
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

    @objc func togglePin(_ sender: NSMenuItem) {
        guard let sid = sender.representedObject as? String, !sid.isEmpty else { return }
        callPage("csm.togglePin", sid)
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

    // Tells the page how a dictation goes: window.csm.dictation({sid, state, text, ...}).
    // JSON, so any words are safe in the call.
    func sendDictation(_ payload: [String: Any]) {
        guard pageLoaded,
              let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        web.evaluateJavaScript("window.csm?.dictation?.(\(json))", completionHandler: nil)
    }

    // Calls a page function with one string, safely quoted as JSON.
    func callPage(_ function: String, _ value: String) {
        guard pageLoaded,
              let data = try? JSONSerialization.data(withJSONObject: value, options: .fragmentsAllowed),
              let arg = String(data: data, encoding: .utf8) else { return }
        web.evaluateJavaScript("\(function)(\(arg))", completionHandler: nil)
    }

    // The same, with a true or false.
    func callPage(_ function: String, _ value: Bool) {
        guard pageLoaded else { return }
        web.evaluateJavaScript("\(function)(\(value ? "true" : "false"))", completionHandler: nil)
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

    // A very large screen at 1x makes 14 px text tiny, so dense screens get 150% unless you
    // pick a size. The longer side counts, so a large screen turned vertical counts too.
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
        // The page's breakpoints are in its own pixels: the narrowest window keeps 171 of them.
        window.minSize = NSSize(width: 171 * zoom, height: 260)
        fitViewSwitch()
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
                    self.pageSendsStatus = false // the new page says so again
                    self.dictation.cancel() // the card that was listening goes with the old page
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
            self.tellPageLanguage()
            if let r = self.availableUpdate { self.noteUpdate(r) } // a reloaded page shows it again
        }
    }

    nonisolated func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        Task { @MainActor in
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self.loadWhenReady() }
        }
    }

    // The web view stays on the local server: the page there gets the app's bridge, so
    // nothing else may load in it. This project's release pages open in the browser;
    // anything else is dropped.
    nonisolated static func isLocalPage(_ url: URL) -> Bool {
        if url.absoluteString == "about:blank" { return true }
        return url.scheme == "http" && url.host == "127.0.0.1" && url.port == port
    }

    nonisolated func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                             decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        MainActor.assumeIsolated {
            guard let url = navigationAction.request.url, !Self.isLocalPage(url) else { return decisionHandler(.allow) }
            if url.scheme == "https", url.absoluteString.hasPrefix(self.releasesHome + "/") || url.absoluteString == self.releasesHome {
                NSWorkspace.shared.open(url)
            } else {
                Self.log("blocked a navigation away from the local page")
            }
            decisionHandler(.cancel)
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
            .separator(),
            languageMenuItem(),
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
            statusSoundItem, loginItem, languageMenuItem(),
            .separator(),
            item("Settings…", #selector(showSettings), ""),
            item("Check for Updates…", #selector(checkForUpdates), ""),
            item("Open in Browser", #selector(openBrowser), ""),
            .separator(),
            item("Quit \(appName)", #selector(NSApplication.terminate(_:)), "q"),
        ]
        statusItem.menu = menu
        rebuildSizeMenus()
        rebuildLanguageMenus()
        paintSound()
        refreshLoginItem()
    }

    @objc func showWindowAction() { showWindow() }

    // The language a spoken answer is heard in: Spanish (Mexico) unless you pick English.
    // It applies from the next press of a card's microphone.
    func languageMenuItem() -> NSMenuItem {
        let top = NSMenuItem(title: "Dictation Language", action: nil, keyEquivalent: "")
        let menu = NSMenu()
        top.submenu = menu
        languageMenus.append(menu)
        return top
    }

    func rebuildLanguageMenus() {
        let chosen = dictation.language
        for menu in languageMenus {
            menu.items = Dictation.languages.map { code, name in
                let i = item(name, #selector(chooseLanguage(_:)), "")
                i.representedObject = code
                i.state = code == chosen ? .on : .off
                return i
            }
        }
    }

    @objc func chooseLanguage(_ sender: NSMenuItem) {
        guard let code = sender.representedObject as? String else { return }
        dictation.language = code
        rebuildLanguageMenus()
        tellPageLanguage()
    }

    // The page learns the language (and its send phrases) when it loads and when you change it,
    // so a composer shows the right one from its first frame.
    func tellPageLanguage() {
        let lang = dictation.language
        sendDictation(["lang": lang, "phrases": dictation.phrases(lang), "keep": dictation.keepPhrase])
    }

    // The menu bar menu starts with what needs you, the same list as the window's first
    // cards: each session's title and why, in its state's color. A click opens it in the
    // Claude app; a task that can't run opens the run that holds it up.
    struct NeedsEntry: Equatable { let title: String; let why: String; let sid: String; let error: Bool }

    nonisolated func needsEntries(_ json: [String: Any]) -> [NeedsEntry] {
        let one = { (text: String) in text.split(whereSeparator: \.isNewline).first.map(String.init) ?? text }
        var out: [NeedsEntry] = []
        for s in json["sessions"] as? [[String: Any]] ?? [] where s["needsYou"] as? Bool == true {
            let status = s["status"] as? String ?? ""
            let why: String
            switch status {
            case "waiting": why = s["wait"] as? String ?? "Waiting for your answer"
            case "error": why = s["error"] as? String ?? "The turn ended with an error"
            default: why = s["ask"] as? String ?? "It asked you something"
            }
            out.append(NeedsEntry(title: s["title"] as? String ?? "Session", why: one(why),
                                  sid: s["sid"] as? String ?? "", error: status == "error"))
        }
        for t in json["tasks"] as? [[String: Any]] ?? [] {
            guard let b = t["blocked"] as? [String: Any], b["queued"] as? Bool != true else { continue }
            let run = (b["run"] as? [String: Any])?["sid"] as? String ?? ""
            out.append(NeedsEntry(title: t["name"] as? String ?? "Scheduled task", why: "Can't run: its last run is still open",
                                  sid: run, error: true))
        }
        return out
    }

    func paintNeedsMenu(_ entries: [NeedsEntry]) {
        let key = entries.map { "\($0.sid)|\($0.title)|\($0.why)" }.joined(separator: "\n")
        guard key != needsMenuKey, let menu = statusItem?.menu else { return }
        needsMenuKey = key
        for i in needsMenuItems { menu.removeItem(i) }
        var items: [NSMenuItem] = [.sectionHeader(title: entries.isEmpty ? "You're all caught up" : entries.count == 1 ? "1 Needs You" : "\(entries.count) Need You")]
        let shown = entries.prefix(8)
        for e in shown {
            let i = NSMenuItem(title: e.title, action: e.sid.isEmpty ? #selector(showWindowAction) : #selector(openSession(_:)), keyEquivalent: "")
            i.target = self
            i.representedObject = e.sid
            let why = e.why.count > 70 ? String(e.why.prefix(69)) + "…" : e.why
            let text = NSMutableAttributedString(string: e.title, attributes: [.font: NSFont.menuFont(ofSize: 0)])
            text.append(NSAttributedString(string: "\n" + why, attributes: [
                .font: NSFont.menuFont(ofSize: NSFont.smallSystemFontSize), .foregroundColor: NSColor.secondaryLabelColor]))
            i.attributedTitle = text
            i.toolTip = e.why
            let dot = NSImage(systemSymbolName: e.error ? "exclamationmark.triangle.fill" : "circle.fill", accessibilityDescription: e.error ? "Error" : "Needs you")?
                .withSymbolConfiguration(.init(pointSize: e.error ? 11 : 8, weight: .regular)
                    .applying(.init(paletteColors: [e.error ? .systemRed : .systemOrange])))
            i.image = dot
            items.append(i)
        }
        if entries.count > shown.count {
            items.append(item("\(entries.count - shown.count) More in the Window…", #selector(showWindowAction), ""))
        }
        items.append(.separator())
        for (n, i) in items.enumerated() { menu.insertItem(i, at: n) }
        needsMenuItems = items
    }

    // The server's own list of what needs you, with its words, when it sends one.
    nonisolated func attentionEntries(_ value: Any?) -> [NeedsEntry]? {
        guard let list = value as? [[String: Any]] else { return nil }
        let one = { (text: String) in text.split(whereSeparator: \.isNewline).first.map(String.init) ?? text }
        let isSession = { (id: String) in UUID(uuidString: id) != nil } // what the Claude app can open
        return list.map { a in
            let kind = a["kind"] as? String ?? ""
            let id = a["id"] as? String ?? ""
            let sid = [a["sid"] as? String, a["run"] as? String, id].compactMap { $0 }.first(where: isSession) ?? ""
            let error = a["error"] as? Bool ?? ["error", "task", "blocked"].contains(kind)
            let fallback = kind == "task" ? "Scheduled task" : "Session"
            return NeedsEntry(title: a["title"] as? String ?? fallback, why: one(a["words"] as? String ?? ""), sid: sid, error: error)
        }
    }

    // A 2 s tick. While the page posts its counts and the server answers, it asks the
    // server only once a minute; before that (an older page, or while offline), every tick.
    func statusTick() {
        let every: TimeInterval = pageSendsStatus && liveState == true ? 60 : 2
        if Date().timeIntervalSince(lastStatusAt) >= every - 0.5 { refreshStatus() }
    }

    // The page's counts, sent as they change. Without the list, the server has the words.
    func applyPageStatus(_ status: [String: Any]) {
        pageSendsStatus = true
        lastStatusAt = Date()
        setLive(true)
        let needs = (status["needs"] as? NSNumber)?.intValue ?? 0
        let working = (status["working"] as? NSNumber)?.intValue ?? 0
        if let entries = attentionEntries(status["attention"]) {
            paintNeedsMenu(entries)
        } else {
            refreshStatus()
        }
        paintStatus(needs: needs, working: working, ok: true)
    }

    // The count of what needs you comes from the server, the same number the window
    // shows: blocked on you, or a question or an error from the last day. In orange.
    func refreshStatus() {
        lastStatusAt = Date()
        URLSession.shared.dataTask(with: stateURL) { data, _, _ in
            var waiting = 0
            var working = 0
            var entries: [NeedsEntry]? = nil
            if let data, let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let sessions = json["sessions"] as? [[String: Any]] {
                waiting = json["needs"] as? Int ?? 0
                working = sessions.filter { $0["status"] as? String == "working" }.count
                entries = self.attentionEntries(json["attention"]) ?? self.needsEntries(json)
            }
            let ok = data != nil
            Task { @MainActor in
                self.setLive(ok)
                if let entries { self.paintNeedsMenu(entries) }
                self.paintStatus(needs: waiting, working: working, ok: ok)
                // Nobody answers and nothing is starting: start the server again.
                if !ok && self.keeper.process == nil { self.keeper.launch() }
            }
        }.resume()
    }

    func paintStatus(needs waiting: Int, working: Int, ok: Bool) {
        NSApp.dockTile.badgeLabel = waiting > 0 ? "\(waiting)" : nil
        guard let button = statusItem?.button else { return }
        button.attributedTitle = waiting > 0
            ? NSAttributedString(string: " \(waiting)", attributes: [
                .foregroundColor: NSColor(srgbRed: 0.98, green: 0.55, blue: 0, alpha: 1),
                .font: NSFont.monospacedDigitSystemFont(ofSize: 13, weight: .semibold)])
            : NSAttributedString(string: "")
        let needs = waiting == 1 ? "1 needs you" : "\(waiting) need you" // sessions, and tasks that can't run
        button.toolTip = ok ? "\(appName)\n\(needs) · \(working) working" : "\(appName): server offline"
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
        // Send by voice: the words that end a dictation and send it, one field per language.
        var phraseRows: [[NSView]] = []
        for (i, (id, name)) in Dictation.languages.enumerated() {
            let field = NSTextField(string: "")
            field.placeholderString = Dictation.defaultPhrases[id] ?? ""
            field.target = self
            field.action = #selector(savePhrases)
            field.cell?.sendsActionOnEndEditing = true
            field.widthAnchor.constraint(equalToConstant: 220).isActive = true
            field.setAccessibilityLabel("Words that send a dictation in \(name)")
            settingsPhrases[id] = field
            let row = NSStackView(views: [field, label(name)])
            row.spacing = 8
            phraseRows.append([label(i == 0 ? "Send by voice:" : ""), row])
        }
        let keep = NSButton(checkboxWithTitle: "Keep those words in the answer", target: self, action: #selector(toggleKeepPhrase))
        let phraseNote = label("End what you dictate with them and pause, and it's sent. Separate several with commas.")
        phraseNote.textColor = .secondaryLabelColor
        phraseNote.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        let cues = NSButton(checkboxWithTitle: "Play a sound when the mic starts and stops listening", target: self, action: #selector(toggleDictationSounds))
        let grid = NSGridView(views: [
            [label("Alerts:"), sound],
            [label("Startup:"), login],
            [label("Text size:"), size],
            [label("Claude Code:"), hookRow],
            [label("Updates:"), updates],
        ] + phraseRows + [
            [label(""), keep],
            [label(""), phraseNote],
            [label(""), cues],
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
        settingsKeepPhrase = keep
        settingsCues = cues
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
        for (id, field) in settingsPhrases where field.currentEditor() == nil { field.stringValue = defaults.string(forKey: "sendPhrases.\(id)") ?? "" }
        settingsKeepPhrase?.state = defaults.bool(forKey: "keepSendPhrase") ? .on : .off
        settingsCues?.state = (defaults.object(forKey: "dictationSounds") as? Bool ?? true) ? .on : .off
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

    // An empty field goes back to the phrase shown in it (the default for that language).
    @objc func savePhrases() {
        for (id, field) in settingsPhrases {
            let words = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            if words.isEmpty { defaults.removeObject(forKey: "sendPhrases.\(id)") } else { defaults.set(words, forKey: "sendPhrases.\(id)") }
        }
        tellPageLanguage()
    }

    @objc func toggleKeepPhrase() {
        defaults.set(!defaults.bool(forKey: "keepSendPhrase"), forKey: "keepSendPhrase")
        refreshSettings()
        tellPageLanguage()
    }

    // Turned on, it plays the start cue, so you hear what it is.
    @objc func toggleDictationSounds() {
        let on = !(defaults.object(forKey: "dictationSounds") as? Bool ?? true)
        defaults.set(on, forKey: "dictationSounds")
        if on { Cue.play(Cue.start) }
        refreshSettings()
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
        alert.messageText = "\(appName) can't start"
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
        // Each file is written next to the old one and renamed over it in one step, so a
        // hook that runs meanwhile finds the old file or the new one, never none.
        for name in ["session-hook.sh", "event.jq", "statusline.sh"] {
            let from = source.appendingPathComponent(name)
            let to = hookDir.appendingPathComponent(name)
            if fm.contentsEqual(atPath: from.path, andPath: to.path) { continue }
            let temp = hookDir.appendingPathComponent(".\(name).\(UUID().uuidString)")
            do {
                try fm.copyItem(at: from, to: temp)
                if name.hasSuffix(".sh") { try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: temp.path) }
                guard rename(temp.path, to.path) == 0 else { throw CocoaError(.fileWriteUnknown) }
            } catch {
                try? fm.removeItem(at: temp)
                throw error
            }
        }
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: hookFile.path)
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: hookDir.appendingPathComponent("statusline.sh").path)
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
        alert.informativeText = "To see your sessions, the app adds a small hook to Claude Code's settings (~/.claude/settings.json), and a status line for your weekly usage if you have none. It saves a copy of the file first and changes nothing else. To read the usage, it also opens Claude Code out of sight for a few seconds every 10 minutes, sending nothing. You can remove it all in Settings."
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

// MARK: dictation

// A spoken answer on a session's card. The page asks to start, stop or cancel; the app
// listens on the microphone and turns speech into words on this Mac only, never on a
// server, and hands them to the page as they come. One card at a time. Nothing is
// written anywhere: the words live on the card until you send or drop them.
@MainActor
// The dictation's two cues: two soft notes going up when the mic starts listening, the same
// two going down when it stops, so you hear when to speak and that it took your words. They're
// made here as tones, with no sound files, unless you set your own (a file's path in the
// settings dictationStartSound and dictationStopSound). Settings › Send by voice can turn them off.
enum Cue {
    static let madeStart = tone([(659.3, 0, 0.06), (880, 0.075, 0.11)]) // E5, then A5
    static let madeDone = tone([(880, 0, 0.06), (659.3, 0.075, 0.11)])
    static var start: NSSound? { own("dictationStartSound") ?? madeStart }
    static var done: NSSound? { own("dictationStopSound") ?? madeDone }

    // Your own sound for a cue, loaded once per file and kept, so it plays to the end.
    private static var loaded: [String: NSSound] = [:]
    private static func own(_ key: String) -> NSSound? {
        guard let set = UserDefaults.standard.string(forKey: key), !set.isEmpty else { return nil }
        let path = (set as NSString).expandingTildeInPath
        if let sound = loaded[path] { return sound }
        guard let sound = NSSound(contentsOfFile: path, byReference: false) else { return nil }
        loaded[path] = sound
        return sound
    }

    static func play(_ sound: NSSound?) {
        guard let sound else { return }
        sound.stop()
        sound.play()
    }

    // Each note: its pitch, when it starts and how fast it fades, a quick rise and a soft
    // overtone. 16-bit mono WAV in memory, about a third of a second, at -12 dB or so.
    static func tone(_ notes: [(Double, Double, Double)]) -> NSSound? {
        let rate = 44_100.0
        var samples = [Double](repeating: 0, count: Int(rate * 0.34))
        for (pitch, at, fade) in notes {
            for i in Int(at * rate)..<samples.count {
                let t = Double(i) / rate - at
                let level = min(1, t / 0.005) * exp(-t / fade) * (i > samples.count - 400 ? Double(samples.count - i) / 400 : 1)
                samples[i] += 0.22 * level * (sin(2 * .pi * pitch * t) + 0.16 * sin(4 * .pi * pitch * t))
            }
        }
        var data = Data()
        func put(_ text: String) { data.append(contentsOf: Array(text.utf8)) }
        func put32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) } }
        func put16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) } }
        put("RIFF"); put32(UInt32(36 + samples.count * 2)); put("WAVE")
        put("fmt "); put32(16); put16(1); put16(1); put32(44_100); put32(88_200); put16(2); put16(16)
        put("data"); put32(UInt32(samples.count * 2))
        for v in samples { put16(UInt16(bitPattern: Int16(max(-1, min(1, v)) * 32_767))) }
        return NSSound(data: data)
    }
}

final class Dictation {
    static let languages = [("en-US", "English (US)"), ("es-MX", "Spanish (Mexico)")]
    // Until you choose one in the menu bar menu: Spanish if it comes first in your Mac's
    // languages, else English.
    static var macLanguage: String { (Locale.preferredLanguages.first ?? "").hasPrefix("es") ? "es-MX" : "en-US" }
    // What ends a dictation and sends it, until you set your own in Settings.
    static let defaultPhrases = ["es-MX": "enviar mensaje", "en-US": "send message"]
    static let cap: TimeInterval = 60 // a dictation stops by itself after a minute
    static let finalWait: TimeInterval = 1.5 // after stop, how long the last words may take

    let defaults = UserDefaults.standard
    let send: ([String: Any]) -> Void // to the page

    private var sid: String? // the card listening, or asking for permission
    private var lang = "en-US" // set from `language` at each start
    private var run = 0 // each start gets a number; callbacks from an older one are dropped
    private var capture: AVCaptureSession? // the microphone, read straight from its device
    private var feeder: AudioFeeder?
    private var lastSound = Date() // when the microphone last gave more than silence
    private var silenceTimer: Timer?
    // For the log only, never words: how much audio came, how loud, and how many results.
    private var buffers = 0, loudest = -160.0, partials = 0, startedAt = Date()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var recognizer: SFSpeechRecognizer?
    private var text = ""
    // After a pause the recognizer starts a new utterance and reports only its words. What
    // came before is kept here, so a sentence, a pause and "send it" stay one answer.
    private var said = "" // the utterances before this one
    private var current = "" // this one, as the recognizer has it now
    private var currentStart = -1.0 // when this one's first word was spoken, in the audio
    private var utterances = 0
    private var level = 0.0
    private var lastSent = Date.distantPast
    private var stopping = false
    private var capTimer: Timer?
    private var finalTimer: Timer?

    init(send: @escaping ([String: Any]) -> Void) { self.send = send }

    var language: String {
        get {
            let saved = defaults.string(forKey: "dictationLocale") ?? ""
            return Self.languages.contains { $0.0 == saved } ? saved : Self.macLanguage
        }
        set { defaults.set(newValue, forKey: "dictationLocale") }
    }

    // The send phrases for a language, as set in Settings (comma-separated), and whether they stay in the answer.
    func phrases(_ lang: String) -> [String] {
        let set = defaults.string(forKey: "sendPhrases.\(lang)") ?? Self.defaultPhrases[lang] ?? ""
        return set.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
    }
    var keepPhrase: Bool { defaults.bool(forKey: "keepSendPhrase") }
    // The start and stop cues, on unless turned off in Settings.
    var cuesOn: Bool { defaults.object(forKey: "dictationSounds") as? Bool ?? true }

    func handle(_ body: [String: Any]) {
        switch body["cmd"] as? String {
        case "start": if let s = body["sid"] as? String, !s.isEmpty { start(s) }
        case "stop": stop()
        case "cancel": cancel()
        default: break
        }
    }

    // A press on a card's microphone. Another card that was listening stops and drops its
    // words; one already stopped, waiting for its last words, keeps what it has.
    func start(_ newSid: String) {
        if let old = sid {
            if stopping, old != newSid {
                finish()
            } else {
                end()
                if old != newSid { send(["sid": old, "state": "canceled"]) }
            }
        }
        sid = newSid
        lang = language
        let mine = run
        // Asked on the first press only; macOS remembers the answer.
        Self.askPermission { granted in
            Task { @MainActor in
                guard mine == self.run else { return } // canceled or replaced while asking
                if granted { self.listen() } else { self.fail("denied") }
            }
        }
    }

    // Stops listening and keeps the words: the page gets them as "done".
    func stop() {
        guard sid != nil, !stopping else { return }
        stopping = true
        capTimer?.invalidate()
        let listening = capture != nil
        stopAudio() // the microphone goes off at once
        if listening, cuesOn { MainActor.assumeIsolated { Cue.play(Cue.done) } } // stop runs on the main thread
        request?.endAudio()
        guard task != nil else { return finish() } // still asking for permission: nothing heard
        let mine = run
        finalTimer = Timer.scheduledTimer(withTimeInterval: Self.finalWait, repeats: false) { _ in
            Task { @MainActor in if mine == self.run { self.finish() } }
        }
    }

    // Stops and drops everything; the page already knows.
    func cancel() {
        guard sid != nil else { return }
        end()
    }

    private func listen() {
        // On this Mac only: a language without its on-device model is unavailable, never sent off.
        guard let r = SFSpeechRecognizer(locale: Locale(identifier: lang)), r.isAvailable, r.supportsOnDeviceRecognition else {
            return fail("unavailable")
        }
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.requiresOnDeviceRecognition = true
        req.shouldReportPartialResults = true
        req.addsPunctuation = true
        recognizer = r
        request = req
        // The microphone is read with a capture session, not an audio engine: an engine also
        // runs the output device, and with a display or a virtual device as the output it
        // either won't start ("hardware not running") or hears nothing.
        guard let device = AVCaptureDevice.default(for: .audio),
              let input = try? AVCaptureDeviceInput(device: device) else { return fail("failed", "no microphone") }
        let session = AVCaptureSession()
        let output = AVCaptureAudioDataOutput()
        output.audioSettings = [ // what the recognizer reads best: 16 kHz mono, 16-bit
            AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 16_000, AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsNonInterleaved: false,
        ]
        guard session.canAddInput(input), session.canAddOutput(output) else { return fail("failed", "microphone busy") }
        session.addInput(input)
        session.addOutput(output)
        let mine = run
        let feed = AudioFeeder(req) { db in Task { @MainActor in self.heard(db, run: mine) } }
        output.setSampleBufferDelegate(feed, queue: AudioFeeder.queue)
        capture = session
        feeder = feed
        lastSound = Date()
        buffers = 0; loudest = -160; partials = 0; startedAt = Date()
        if cuesOn { MainActor.assumeIsolated { Cue.play(Cue.start) } } // listen runs on the main thread
        AudioFeeder.queue.async { session.startRunning() } // it blocks until the device runs
        // A microphone that gives only silence (muted, or macOS holding it back) would leave
        // the card listening forever: after 4 s of nothing, say so.
        silenceTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
            Task { @MainActor in
                guard mine == self.run, !self.stopping, self.text.isEmpty else { return }
                if Date().timeIntervalSince(self.lastSound) > 4 { self.fail("silent") }
            }
        }
        task = r.recognitionTask(with: req, resultHandler: Self.results { words, final, error, ended, start in
            Task { @MainActor in self.recognized(words, final: final, error: error, ended: ended, start: start, run: mine) }
        })
        capTimer = Timer.scheduledTimer(withTimeInterval: Self.cap, repeats: false) { _ in
            Task { @MainActor in if mine == self.run { self.stop() } }
        }
        sendListening()
    }

    // The microphone's level in decibels, many times a second: -50 dB to 0 as 0 to 1, quick
    // to rise, slow to fall, and passed on to the page about 10 times a second.
    private func heard(_ db: Double, run mine: Int) {
        guard mine == run, sid != nil, !stopping else { return }
        buffers += 1
        loudest = max(loudest, db)
        if db > -90 { lastSound = Date() } // a quiet room still hums; true silence is far below
        let value = max(0, min(1, (db + 50) / 50))
        level = max(value, level * 0.8)
        if Date().timeIntervalSince(lastSent) >= 0.1 { sendListening() }
    }

    private func recognized(_ words: String?, final: Bool, error: String?, ended: Bool, start: Double, run mine: Int) {
        guard mine == run, sid != nil else { return }
        if words != nil { partials += 1 }
        if final || error != nil { ShellLog.write("dictation result: final \(final), error \(error ?? "none"), stopping \(stopping), \(utterances) utterances before") }
        if let words {
            let w = words.trimmingCharacters(in: .whitespacesAndNewlines)
            if startsOver(w, at: start) { keepCurrent() }
            if current.isEmpty || currentStart <= 0 { currentStart = start } // 0 or less: no timing yet
            current = w
            if ended { keepCurrent() } // the recognizer closed this utterance: the next result is a new one
            text = joined()
        }
        if stopping {
            // After stop, an error is often "no speech": whatever was heard stands.
            if final || error != nil { finish() }
        } else if let error {
            fail("failed", error)
        } else if final {
            finish() // the recognizer ended on its own: keep what it heard
        } else {
            sendListening()
        }
    }

    private func sendListening() {
        guard let sid else { return }
        lastSent = Date()
        send(["sid": sid, "state": "listening", "text": text, "level": (level * 100).rounded() / 100, "lang": lang, "phrases": phrases(lang), "keep": keepPhrase])
    }

    private func finish() {
        guard let s = sid else { return }
        let words = text
        end()
        send(["sid": s, "state": "done", "text": words, "lang": lang, "phrases": phrases(lang), "keep": keepPhrase])
    }

    // The log gets the error's kind only, never words.
    private func fail(_ kind: String, _ detail: String? = nil) {
        guard let s = sid else { return }
        ShellLog.write("dictation \(kind)\(detail.map { ": \($0)" } ?? "") (\(lang))")
        end()
        send(["sid": s, "state": "error", "error": kind, "lang": lang])
    }

    // A new utterance: its first word was spoken well after this one's, or (with no timing)
    // it shares nothing with it and is much shorter, as when "Send it" follows a whole sentence.
    private func startsOver(_ w: String, at start: Double) -> Bool {
        guard !current.isEmpty, !w.isEmpty else { return false }
        if start > 0, currentStart > 0 { return start > currentStart + 0.5 }
        let first = { (t: String) in t.lowercased().split(whereSeparator: { !$0.isLetter && !$0.isNumber }).first.map(String.init) ?? "" }
        return first(w) != first(current) && w.count * 2 < current.count
    }

    private func keepCurrent() {
        guard !current.isEmpty else { return }
        said = said.isEmpty || Self.fold(current).hasPrefix(Self.fold(said)) ? current : said + " " + current
        utterances += 1
        current = ""
        currentStart = -1
    }

    // What was said so far. A recognizer that does report the whole dictation again (some
    // systems do, at the end) isn't doubled.
    private func joined() -> String {
        if said.isEmpty { return current }
        if current.isEmpty { return said }
        return Self.fold(current).hasPrefix(Self.fold(said)) ? current : said + " " + current
    }
    // Letters and digits only, without case or accents: to tell the same words apart from new ones.
    nonisolated static func fold(_ t: String) -> String {
        String(t.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil).filter { $0.isLetter || $0.isNumber })
    }

    // Everything off and forgotten; late callbacks from this run are dropped.
    private func end() {
        if sid != nil {
            ShellLog.write("dictation ended after \(Int(Date().timeIntervalSince(startedAt)))s: \(buffers) audio buffers, loudest \(Int(loudest)) dB, \(partials) results, \(utterances + (current.isEmpty ? 0 : 1)) utterances, \(text.count) characters")
        }
        run += 1
        capTimer?.invalidate()
        finalTimer?.invalidate()
        silenceTimer?.invalidate()
        capTimer = nil
        finalTimer = nil
        silenceTimer = nil
        stopAudio()
        request?.endAudio()
        task?.cancel()
        task = nil
        request = nil
        recognizer = nil
        sid = nil
        text = ""
        said = ""
        current = ""
        currentStart = -1
        utterances = 0
        level = 0
        stopping = false
    }

    private func stopAudio() {
        silenceTimer?.invalidate()
        silenceTimer = nil
        guard let session = capture else { return }
        capture = nil
        feeder = nil
        AudioFeeder.queue.async { session.stopRunning() } // after any start still on its way
    }

    // The callbacks below run on audio and speech threads, so they're built outside the
    // main actor and hop back to it.

    nonisolated static func askPermission(_ done: @escaping @Sendable (Bool) -> Void) {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: askMicrophone(done)
        case .notDetermined: SFSpeechRecognizer.requestAuthorization { $0 == .authorized ? askMicrophone(done) : done(false) }
        default: done(false) // denied or restricted
        }
    }

    nonisolated static func askMicrophone(_ done: @escaping @Sendable (Bool) -> Void) {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: done(true)
        case .notDetermined: AVCaptureDevice.requestAccess(for: .audio) { done($0) }
        default: done(false)
        }
    }

    // The words, whether they're final, an error, whether the recognizer closed the utterance
    // (it attaches its metadata then), and when its first word was spoken (-1 if it can't say).
    nonisolated static func results(_ done: @escaping @Sendable (String?, Bool, String?, Bool, Double) -> Void)
        -> (SFSpeechRecognitionResult?, Error?) -> Void {
        return { result, error in
            let start = result?.bestTranscription.segments.first.map { $0.timestamp } ?? -1
            done(result?.bestTranscription.formattedString, result?.isFinal ?? false, error.map(kind),
                 result?.speechRecognitionMetadata != nil && result?.isFinal == false, start)
        }
    }

    nonisolated static func kind(_ error: Error) -> String {
        let e = error as NSError
        return "\(e.domain) \(e.code)"
    }
}

// Takes the microphone's audio on its own queue: feeds the recognizer and reports the level.
final class AudioFeeder: NSObject, AVCaptureAudioDataOutputSampleBufferDelegate, @unchecked Sendable {
    static let queue = DispatchQueue(label: "dictation.audio")
    let request: SFSpeechAudioBufferRecognitionRequest
    let level: @Sendable (Double) -> Void

    init(_ request: SFSpeechAudioBufferRecognitionRequest, level: @escaping @Sendable (Double) -> Void) {
        self.request = request
        self.level = level
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        request.appendAudioSampleBuffer(sampleBuffer)
        let db = connection.audioChannels.map { Double($0.averagePowerLevel) }.max() ?? -160
        level(db.isFinite ? db : -160)
    }
}

MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.regular) // a Dock icon and Cmd-Tab, like any app
    app.run()
}
