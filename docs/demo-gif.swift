// Records docs/demo.gif: the top of the page on the demo's four sessions, in WebKit (the
// app's own engine): a window 1100 points wide, so three cards fit in a row, scaled down to
// 880 px. It starts the demo itself (`bun test/demo.ts --gif`, in UTC, on port 4821), cues
// its story and stops it: the checkout fix stops on a permission and turns Needs you, then
// the audit's agents finish and it turns Done. Needs ffmpeg.
//
//   swift docs/demo-gif.swift docs/demo.gif
import AppKit
import WebKit

let args = CommandLine.arguments
guard args.count > 1 else {
  print("usage: swift docs/demo-gif.swift <out.gif>")
  exit(1)
}
let out = URL(fileURLWithPath: args[1]).path
let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
let port = 4821
var size = NSSize(width: 1100, height: 250) // the part of the page in the GIF, in its own pixels
let gifWidth = 880
let fps = 12.5
let length = 9.0 // seconds
let cueAt = 1.5 // seconds into the recording

let frames = FileManager.default.temporaryDirectory.appendingPathComponent("csm-gif-\(getpid())")
try? FileManager.default.createDirectory(at: frames, withIntermediateDirectories: true)

// The demo, in UTC, with its story waiting for a line on stdin.
let demo = Process()
demo.executableURL = URL(fileURLWithPath: "/usr/bin/env")
demo.arguments = ["bun", "test/demo.ts", "--gif", String(port)]
demo.currentDirectoryURL = root
demo.environment = ProcessInfo.processInfo.environment.merging(["TZ": "UTC"]) { _, new in new }
let cue = Pipe()
demo.standardInput = cue
demo.standardOutput = FileHandle.nullDevice
try demo.run()

func finish(_ code: Int32) -> Never {
  demo.terminate()
  demo.waitUntilExit()
  try? FileManager.default.removeItem(at: frames)
  exit(code)
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let window = NSWindow(contentRect: NSRect(origin: .zero, size: NSSize(width: size.width, height: 700)),
                      styleMask: [.borderless], backing: .buffered, defer: false)
// The page's clock in UTC, whatever the Mac's time zone, so the times in the GIF say
// nothing about where it was recorded.
let utc = WKUserScript(source: """
  (() => {
    const pin = (f, at) => function (loc, o) { return f.call(this, loc, { ...(o || {}), timeZone: "UTC" }); };
    for (const k of ["toLocaleString", "toLocaleDateString", "toLocaleTimeString"]) Date.prototype[k] = pin(Date.prototype[k]);
    for (const k of ["FullYear", "Month", "Date", "Day", "Hours", "Minutes", "Seconds"]) Date.prototype["get" + k] = Date.prototype["getUTC" + k];
    for (const k of ["FullYear", "Month", "Date", "Hours", "Minutes", "Seconds", "Milliseconds"]) Date.prototype["set" + k] = Date.prototype["setUTC" + k];
    Date.prototype.getTimezoneOffset = () => 0;
    const DTF = Intl.DateTimeFormat;
    Intl.DateTimeFormat = function (loc, o) { return new DTF(loc, { ...(o || {}), timeZone: "UTC" }); };
    Intl.DateTimeFormat.prototype = DTF.prototype;
  })();
  """, injectionTime: .atDocumentStart, forMainFrameOnly: true)
let config = WKWebViewConfiguration()
config.userContentController.addUserScript(utc)
let web = WKWebView(frame: window.contentLayoutRect, configuration: config)
window.contentView = web
// On screen, so WebKit keeps drawing, but clear, behind everything and never key: nothing
// shows while it records, and the pointer never hovers the page.
window.alphaValue = 0
window.ignoresMouseEvents = true
window.orderBack(nil)

final class Recorder: NSObject, WKNavigationDelegate {
  var start = Date()
  var count = 0
  var cued = false

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    // The cards come in over a second or two, then the recording starts, down to just
    // below the first row of Active.
    DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
      let js = """
      document.documentElement.style.setProperty('--csm-scale', '\(window.backingScaleFactor)');
      document.querySelector('.card')?.getBoundingClientRect().bottom ?? 0;
      """
      webView.evaluateJavaScript(js) { bottom, _ in
        if let bottom = bottom as? Double, bottom > 0 { size.height = (bottom + 6).rounded(.up) }
        self.start = Date()
        self.shoot(webView)
      }
    }
  }

  // One frame every 1/fps seconds, on the clock rather than after the last one.
  func shoot(_ webView: WKWebView) {
    let t = Date().timeIntervalSince(start)
    if !cued && t >= cueAt {
      cued = true
      cue.fileHandleForWriting.write("play\n".data(using: .utf8)!)
    }
    if t >= length {
      window.orderOut(nil)
      return encode()
    }
    let cfg = WKSnapshotConfiguration()
    cfg.rect = CGRect(origin: .zero, size: size)
    cfg.afterScreenUpdates = true
    webView.takeSnapshot(with: cfg) { image, _ in
      guard let image, let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { finish(1) }
      let file = frames.appendingPathComponent(String(format: "f%04d.png", self.count))
      try? NSBitmapImageRep(cgImage: cg).representation(using: .png, properties: [:])?.write(to: file)
      self.count += 1
      let next = Double(self.count) / fps - Date().timeIntervalSince(self.start)
      DispatchQueue.main.asyncAfter(deadline: .now() + max(0, next)) { self.shoot(webView) }
    }
  }

  // A palette made from the frames themselves, so the GIF stays small and its colors clean.
  func encode() {
    let ffmpeg = Process()
    ffmpeg.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    ffmpeg.arguments = [
      "ffmpeg", "-v", "error", "-y", "-framerate", String(fps), "-i", frames.appendingPathComponent("f%04d.png").path,
      "-filter_complex",
      "scale=\(gifWidth):-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle",
      "-loop", "0", out,
    ]
    do { try ffmpeg.run() } catch { finish(1) }
    ffmpeg.waitUntilExit()
    print("saved \(out), \(count) frames")
    finish(ffmpeg.terminationStatus)
  }
}

let recorder = Recorder()
web.navigationDelegate = recorder
// Give the server a moment to read the demo's files.
DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
  web.load(URLRequest(url: URL(string: "http://127.0.0.1:\(port)/")!))
}
DispatchQueue.main.asyncAfter(deadline: .now() + 60) { finish(1) } // never hang
app.run()
