// Records docs/demo.gif: the top of the page on the demo's four sessions, in WebKit (the
// app's own engine): a window 1100 points wide, so three cards fit in a row, scaled down to
// 880 px. It starts the demo itself (`bun test/demo.ts --gif`, in UTC, on port 4821), cues
// its story and stops it: the checkout fix stops on a permission and turns Needs you, then
// the release notes get an answer from their card (Sent, at once) and go back to
// working. A stand-in for the app's dictation (a "dictate" handler) puts the mic on the
// cards that can take a spoken answer. Needs ffmpeg.
//
// With --dictate the release notes are answered by voice instead: the script presses their
// mic, the stand-in plays the app's side (Listening, then the words a word or two at a time
// with a moving level, in English, ending with the phrase that sends), the page sends them
// on its own (Sending…, then Sent) and the session goes back to working. Then the pointer
// rests on the week's usage beside the cards and its card opens with the week's curve. A
// pointer is drawn, so it shows what opens what. At the end the checkout fix gets its
// permission, the release notes ask again and the pointer goes back where it started: the
// last frame is the first, and the GIF loops without a seam. That GIF is taller, so the
// composer and the usage card stay whole.
//
//   swift docs/demo-gif.swift docs/demo.gif --dictate   (the README's)
//   swift docs/demo-gif.swift docs/demo.gif             (an answer from a button)
import AppKit
import WebKit

let args = CommandLine.arguments
let dictate = args.contains("--dictate")
guard let outArg = args.dropFirst().first(where: { !$0.hasPrefix("--") }) else {
  print("usage: swift docs/demo-gif.swift <out.gif> [--dictate]")
  exit(1)
}
let out = URL(fileURLWithPath: outArg).path
let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
let port = 4821
var size = NSSize(width: 1100, height: 250) // the part of the page in the GIF, in its own pixels
let gifWidth = 880
let fps = 12.5
// Seconds: six times the 2.4 s that the page's beating dots and working dots take, so they too
// are where they started when the loop does.
let length = 14.4
let cueAt = dictate ? 0.6 : 1.5 // the checkout fix stops on a permission
let answerAt = dictate ? 2.4 : 4.0 // when the release notes' first answer (or their mic) is clicked
// --dictate: the pointer goes to the mic (it arrives just before the click), then to the week's
// usage, whose card opens, and back home; the checkout fix resumes, and the release notes,
// which took the answer, ask again (the demo's turn: CSM_DEMO_TURN_MS) at about the same time.
// One thing at a time: the usage card has closed and the pointer is home before the release
// notes ask again (about 11.9 s), and the checkout fix resumes after that.
let toMicAt = 1.5, toUsageAt = 7.2, usageAt = 7.9, homeAt = 11.0, resumeAt = 12.5
let turnMs = "3500"
// What the stand-in hears, made up, ending with the phrase that sends it.
let spoken = "Yes, publish them, but put the breaking change about the old API first. Send message"
let silence = 0.6 // seconds of Listening with no words yet
let wordEvery = 0.24 // seconds between one word or two and the next

let frames = FileManager.default.temporaryDirectory.appendingPathComponent("csm-gif-\(getpid())")
try? FileManager.default.createDirectory(at: frames, withIntermediateDirectories: true)

// The demo, in UTC, with its story waiting for a line on stdin.
let demo = Process()
demo.executableURL = URL(fileURLWithPath: "/usr/bin/env")
demo.arguments = ["bun", "test/demo.ts", "--gif", String(port)]
demo.currentDirectoryURL = root
demo.environment = ProcessInfo.processInfo.environment.merging(dictate ? ["TZ": "UTC", "CSM_DEMO_TURN_MS": turnMs] : ["TZ": "UTC"]) { _, new in new }
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
// The app's dictation, as the page sees it: with a handler named "dictate" the cards that
// can take a spoken answer show their mic. It never listens to anything. With --dictate, a
// start plays what the app would send back: Listening with no words, then the words a word
// or two at a time with a level that moves, ten times a second; the page arms its phrase
// on its own and asks to stop, and the stand-in answers done with the same words.
final class Dictation: NSObject, WKScriptMessageHandler {
  var timer: Timer?
  func say(_ web: WKWebView?, _ m: [String: Any]) {
    guard let web, let data = try? JSONSerialization.data(withJSONObject: m), let json = String(data: data, encoding: .utf8) else { return }
    web.evaluateJavaScript("window.csm?.dictation?.(\(json))")
  }
  func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
    guard dictate, let body = message.body as? [String: Any], let cmd = body["cmd"] as? String else { return }
    let web = message.webView
    if cmd == "start", let sid = body["sid"] as? String {
      let words = spoken.split(separator: " ").map(String.init)
      // A word or two at a time: the groups as the recognizer tends to give them.
      var cuts: [Int] = []
      var i = 0
      while i < words.count { i += (i % 3 == 1) ? 2 : 1; cuts.append(min(i, words.count)) }
      let begun = Date()
      var tick = 0
      timer?.invalidate()
      timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in
        tick += 1
        let t = Date().timeIntervalSince(begun)
        let n = t < silence ? 0 : min(cuts.count, Int((t - silence) / wordEvery) + 1)
        let text = n == 0 ? "" : words.prefix(cuts[n - 1]).joined(separator: " ")
        let talking = n > 0 && n <= cuts.count && t < silence + Double(cuts.count) * wordEvery + 0.2
        let level = talking ? 0.45 + 0.35 * abs(sin(Double(tick) * 1.7)) + 0.1 * sin(Double(tick) * 0.6) : 0.04
        self.say(web, ["sid": sid, "state": "listening", "text": text, "level": (level * 100).rounded() / 100, "lang": "en-US"])
      }
      self.sid = sid
    } else if cmd == "stop" {
      timer?.invalidate()
      say(web, ["sid": sid, "state": "done", "text": spoken, "level": 0, "lang": "en-US"])
    } else if cmd == "cancel" {
      timer?.invalidate()
      say(web, ["sid": sid, "state": "canceled", "lang": "en-US"])
    }
  }
  var sid = ""
}
let dictation = Dictation()
// --dictate: a pointer drawn on the page (the real one never touches this window), at rest in
// the empty space under the cards, where it goes back to at the end. It glides on a calm curve,
// and sinks a little when it clicks.
let pointer = """
  window.csm?.dictation?.({ lang: 'en-US' }); // the app's dictation language, English here, before the first word
  window.__ptr = (() => {
    const p = document.createElement('div');
    p.innerHTML = '<svg width="20" height="26" viewBox="0 0 20 26" aria-hidden="true"><path d="M2 2v19l4.8-4.6 3.3 7.2 3.4-1.5-3.2-7h6.9z" fill="#fff" stroke="#000" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    Object.assign(p.style, { position: 'fixed', left: '0', top: '0', zIndex: '99999', pointerEvents: 'none', transformOrigin: '2px 2px', filter: 'drop-shadow(0 1px 1.5px rgba(0,0,0,.55))' });
    document.body.append(p);
    let xy = [0, 0];
    const at = (x, y, ms) => { xy = [x, y]; p.style.transition = ms ? `transform ${ms}ms cubic-bezier(0.45, 0, 0.2, 1)` : 'none'; p.style.transform = `translate(${x - 2}px, ${y - 2}px)`; };
    const mid = (el, dy) => { const r = el.getBoundingClientRect(); return [r.left + r.width / 2, dy == null ? r.top + r.height / 2 : r.top + dy]; };
    const rest = [690, 330];
    at(...rest, 0);
    return {
      home: (ms) => at(...rest, ms),
      toMic: (ms) => { const m = [...document.querySelectorAll('.card')].find((c) => c.textContent.includes('Release notes'))?.querySelector('[data-mic]'); if (m) { const [x, y] = mid(m); at(x + 3, y + 3, ms); } },
      toUsage: (ms) => { const m = document.querySelector('#week .meter .m-pct') || document.querySelector('#week .meter'); if (m) { const [x, y] = mid(m); at(x + 6, y + 4, ms); } },
      press: () => p.animate([{ transform: `translate(${xy[0] - 2}px, ${xy[1] - 2}px) scale(1)` }, { transform: `translate(${xy[0] - 2}px, ${xy[1] - 2}px) scale(0.86)` }, { transform: `translate(${xy[0] - 2}px, ${xy[1] - 2}px) scale(1)` }], { duration: 220, easing: 'ease-out' }),
    };
  })();
  """
let config = WKWebViewConfiguration()
config.userContentController.addUserScript(utc)
config.userContentController.add(dictation, name: "dictate")
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
  var answered = false
  var steps = Set<String>() // what's been done, once each
  var lowest = 0.0 // the lowest the composer, the usage card or the week's usage reached, in the page's points (--dictate)

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
        // With a composer, frames hold the whole window and the GIF is cut afterwards, at the
        // same height throughout, just below the lowest the composer or the usage card went.
        if dictate { self.lowest = size.height - 6; size.height = window.contentLayoutRect.height }
        if dictate { webView.evaluateJavaScript(pointer) }
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
    if !answered && t >= answerAt {
      answered = true
      let click = """
      \(dictate ? "window.__ptr?.press();" : "")
      [...document.querySelectorAll('.card')].find((c) => c.textContent.includes('Release notes'))?.querySelector('\(dictate ? "[data-mic]" : "[data-answer=\"0\"]")')?.click();
      """
      webView.evaluateJavaScript(click)
    }
    // --dictate: the pointer's trip, and the hover it makes on the week's usage (no movement
    // needed: the page isn't embedded, so it counts the pointer as in the window).
    if dictate {
      let due: [(String, Double, String)] = [
        ("mic", toMicAt, "window.__ptr?.toMic(800)"),
        ("usage", toUsageAt, "window.__ptr?.toUsage(700)"),
        ("hover", usageAt, "document.querySelector('#week .meter')?.dispatchEvent(new PointerEvent('pointerenter'))"),
        ("home", homeAt, "document.querySelector('#week .meter')?.dispatchEvent(new PointerEvent('pointerleave')); window.__ptr?.home(800)"),
      ]
      for (name, at, js) in due where t >= at && !steps.contains(name) {
        steps.insert(name)
        webView.evaluateJavaScript(js)
      }
      if t >= resumeAt && !steps.contains("resume") {
        steps.insert("resume")
        cue.fileHandleForWriting.write("resume\n".data(using: .utf8)!)
      }
    }
    if t >= length {
      window.orderOut(nil)
      return encode()
    }
    if dictate {
      let js = "Math.max(document.getElementById('dict')?.getBoundingClientRect().bottom ?? 0, document.querySelector('#ucard.open')?.getBoundingClientRect().bottom ?? 0, document.querySelector('.abody > .meter')?.getBoundingClientRect().bottom ?? 0)"
      webView.evaluateJavaScript(js) { b, _ in
        if let b = b as? Double { self.lowest = max(self.lowest, b) }
      }
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
    // --dictate: cut the frames below the lowest the composer, the usage card or the week's usage went (an even height, in pixels).
    var crop = ""
    if dictate {
      let keep = min(1, (lowest + 8) / Double(size.height))
      crop = "crop=iw:trunc(ih*\(keep)/2)*2:0:0,"
    }
    let ffmpeg = Process()
    ffmpeg.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    ffmpeg.arguments = [
      "ffmpeg", "-v", "error", "-y", "-framerate", String(fps), "-i", frames.appendingPathComponent("f%04d.png").path,
      "-filter_complex",
      "\(crop)scale=\(gifWidth):-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle",
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
