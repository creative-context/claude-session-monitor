// Draws docs/card-anatomy.png: three of the page's cards on the demo's --anatomy data, one that
// needs you, one working and one done, with each of their parts named. In WebKit (the app's own
// engine), at 2.5 pixels each, so it stays sharp at the README's width; docs/card-anatomy.js lays
// it out inside the page. The mic shows as in the app (a stand-in for its dictation, which
// listens to nothing). Run the demo first.
//
//   bun test/demo.ts --anatomy &
//   swift docs/card-anatomy.swift http://127.0.0.1:4748/ docs/card-anatomy.png
import AppKit
import WebKit

let args = CommandLine.arguments
guard args.count > 2, let url = URL(string: args[1]) else {
  print("usage: swift docs/card-anatomy.swift <page url> <out.png>")
  exit(1)
}
let out = args[2]
let layout = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("card-anatomy.js")
guard let overlay = try? String(contentsOf: layout, encoding: .utf8) else {
  print("can't read \(layout.path)")
  exit(1)
}
let size = NSSize(width: 760, height: 1000) // page pixels: as wide as the picture, taller than it
let scale: CGFloat = 2.5 // drawn at this many pixels each, whatever the screen

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
// Drawn on the Mac's built-in screen, in front and fully clear: WebKit stops drawing a page whose
// window is covered (behind a full-screen app, say), so behind everything it could draw nothing.
// The window is sized for that screen's own pixels, so the picture comes out the same.
let screen = NSScreen.screens.first(where: { $0.localizedName.contains("Built-in") || $0.localizedName.contains("Color LCD") }) ?? NSScreen.main!
let k = scale / screen.backingScaleFactor // points per page pixel on that screen
let window = NSWindow(contentRect: NSRect(origin: screen.frame.origin, size: NSSize(width: size.width * k, height: size.height * k)),
                      styleMask: [.borderless], backing: .buffered, defer: false)
// The page's clock in UTC, whatever the Mac's time zone, so no time on the picture says where it
// was drawn; and the scale the cards fit their tags to, before the page draws them. Then the layout.
let start = WKUserScript(source: """
  (() => {
    const pin = (f) => function (loc, o) { return f.call(this, loc, { ...(o || {}), timeZone: "UTC" }); };
    for (const k of ["toLocaleString", "toLocaleDateString", "toLocaleTimeString"]) Date.prototype[k] = pin(Date.prototype[k]);
    for (const k of ["FullYear", "Month", "Date", "Day", "Hours", "Minutes", "Seconds"]) Date.prototype["get" + k] = Date.prototype["getUTC" + k];
    for (const k of ["FullYear", "Month", "Date", "Hours", "Minutes", "Seconds", "Milliseconds"]) Date.prototype["set" + k] = Date.prototype["setUTC" + k];
    Date.prototype.getTimezoneOffset = () => 0;
    const DTF = Intl.DateTimeFormat;
    Intl.DateTimeFormat = function (loc, o) { return new DTF(loc, { ...(o || {}), timeZone: "UTC" }); };
    Intl.DateTimeFormat.prototype = DTF.prototype;
    document.documentElement.style.setProperty('--csm-scale', '\(scale)');
  })();
  """, injectionTime: .atDocumentStart, forMainFrameOnly: true)
let lay = WKUserScript(source: overlay, injectionTime: .atDocumentEnd, forMainFrameOnly: true)
// The app's dictation, as the page sees it: with a handler named "dictate", a card that can take
// a spoken answer shows its mic. This one never listens.
final class NoDictation: NSObject, WKScriptMessageHandler {
  func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {}
}
// The app's page key, as the app puts it in its page (a read-only window.__csmKey, there from the
// start): without it the page only looks, and its answers and permissions would be drawn as plain
// ones. Made up, and the same as DEMO_PAGE_KEY in test/keys.ts, whose hash the demo takes by default.
let pageKey = "d3a0c4e81f5b2976a4d8e0c3b71f5a29c6e84d0b3f7a15e92c8b6d4f0a3e7c15"
let keyScript = WKUserScript(source: "Object.defineProperty(window, \"__csmKey\", { value: \"\(pageKey)\", writable: false });",
                             injectionTime: .atDocumentStart, forMainFrameOnly: true)
let config = WKWebViewConfiguration()
config.userContentController.addUserScript(keyScript)
config.userContentController.addUserScript(start)
config.userContentController.addUserScript(lay)
config.userContentController.add(NoDictation(), name: "dictate")
let web = WKWebView(frame: window.contentLayoutRect, configuration: config)
web.pageZoom = k
window.contentView = web
// Fully transparent and click-through, in front: nothing shows on your screen. (Off screen or
// covered would count as hidden, and the page draws nothing while hidden.)
window.alphaValue = 0
window.ignoresMouseEvents = true
window.setFrameOrigin(screen.frame.origin)
window.level = .floating
window.orderFrontRegardless()

// Once the layout says the cards hold still, the picture is the part of the page it gives.
func whenReady() {
  web.evaluateJavaScript("window.anatomyReady") { value, _ in
    guard let r = value as? [String: Any], let w = r["w"] as? Double, let h = r["h"] as? Double else {
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.3, execute: whenReady)
      return
    }
    let cfg = WKSnapshotConfiguration()
    cfg.afterScreenUpdates = true
    cfg.rect = CGRect(x: 0, y: 0, width: w * Double(k), height: h * Double(k))
    web.takeSnapshot(with: cfg) { image, _ in
      guard let image, let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { exit(1) }
      try? NSBitmapImageRep(cgImage: cg).representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: out))
      print("saved \(out), \(cg.width)×\(cg.height)")
      exit(0)
    }
  }
}
final class Shot: NSObject, WKNavigationDelegate {
  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { whenReady() }
}
let shot = Shot()
web.navigationDelegate = shot
web.load(URLRequest(url: url))
DispatchQueue.main.asyncAfter(deadline: .now() + 30) { print("timed out"); exit(2) }
app.run()
