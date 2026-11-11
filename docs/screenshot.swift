// Draws docs/screenshot.png: the page on the demo data, in WebKit (the app's own engine),
// at twice the pixels, with the weekly usage card open. Run the demo first.
//
//   bun test/demo.ts --hot &
//   swift docs/screenshot.swift http://127.0.0.1:4748/ docs/screenshot.png
import AppKit
import WebKit

let args = CommandLine.arguments
guard args.count > 2, let url = URL(string: args[1]) else {
  print("usage: swift docs/screenshot.swift <page url> <out.png>")
  exit(1)
}
let out = args[2]
let size = NSSize(width: 880, height: 560) // the page's own pixels
let scale: CGFloat = 2 // drawn at this many pixels each, whatever the screen

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let window = NSWindow(contentRect: NSRect(origin: .zero, size: NSSize(width: size.width * scale, height: size.height * scale)),
                      styleMask: [.borderless], backing: .buffered, defer: false)
let web = WKWebView(frame: window.contentLayoutRect)
web.pageZoom = scale
window.contentView = web
window.orderBack(nil)

final class Shot: NSObject, WKNavigationDelegate {
  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    // The demo's cards come in over a second or two; then the pointer rests on the column.
    DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
      let js = """
      document.documentElement.style.setProperty('--csm-scale', '\(scale * window.backingScaleFactor)');
      document.querySelector('#week .meter')?.dispatchEvent(new PointerEvent('pointerenter'));
      """
      webView.evaluateJavaScript(js) { _, _ in
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
          let cfg = WKSnapshotConfiguration()
          cfg.afterScreenUpdates = true
          webView.takeSnapshot(with: cfg) { image, _ in
            guard let image, let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { exit(1) }
            try? NSBitmapImageRep(cgImage: cg).representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: out))
            print("saved \(out), \(cg.width)×\(cg.height)")
            exit(0)
          }
        }
      }
    }
  }
}
let shot = Shot()
web.navigationDelegate = shot
web.load(URLRequest(url: url))
DispatchQueue.main.asyncAfter(deadline: .now() + 30) { print("timed out"); exit(2) }
app.run()
