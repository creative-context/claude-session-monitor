// mac-app-kit 0.3.1 (DictationKit.swift). Vendored: don't edit here. Change it in the kit and vendor again.
// Dictation for the family's Mac apps, compiled with ShellKit.swift and each app's own
// main.swift (build.sh passes them to swiftc): a field on the page asks to start, stop or
// cancel, and the app listens on the microphone and turns speech into words on this Mac
// only, never on a server, handing them to the page as they come. One field at a time.
// Nothing is written anywhere: the words live in the page until it sends or drops them, and
// the log holds counts, never words.
//   - Cue: the two soft notes when the mic starts and stops listening;
//   - Dictation: start, stop and cancel from the page, the language, the send phrases;
//   - AudioFeeder: the microphone's audio to the recognizer, and its level.
// The app keeps its own menus and settings, and needs NSMicrophoneUsageDescription and
// NSSpeechRecognitionUsageDescription in its Info.plist. The page names the field that
// listens with "sid" (Session Monitor's cards are sessions; another app's id works the same).

import AppKit
import AVFoundation
import Speech

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


// A spoken answer in a field. The page asks to start, stop or cancel; the app listens on the
// microphone and turns speech into words on this Mac only, never on a server, and hands them
// to the page as they come. One field at a time. Nothing is written anywhere: the words live
// in the field until you send or drop them.
final class Dictation {
    static let languages = [("en-US", "English (US)"), ("es-MX", "Spanish (Mexico)")]
    // Until you choose one in the app's menu: Spanish if it comes first in your Mac's
    // languages, else English.
    static var macLanguage: String { (Locale.preferredLanguages.first ?? "").hasPrefix("es") ? "es-MX" : "en-US" }
    // What ends a dictation and sends it, until you set your own in Settings.
    static let defaultPhrases = ["es-MX": "enviar mensaje", "en-US": "send message"]
    static let cap: TimeInterval = 60 // a dictation stops by itself after a minute
    static let finalWait: TimeInterval = 1.5 // after stop, how long the last words may take

    let defaults = UserDefaults.standard
    let send: ([String: Any]) -> Void // to the page

    private var sid: String? // the field listening, or asking for permission
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

    // A press on a field's microphone. Another field that was listening stops and drops its
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
        // the field listening forever: after 4 s of nothing, say so.
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
