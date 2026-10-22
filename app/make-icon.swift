// Draws the app icon at 1024 px in the Obsidian style: a near-black tile with three
// session cards as white veils, each with a status dot (working, needs you, done).
//
//   swift app/make-icon.swift build/icon-1024.png

import AppKit

let size = 1024
let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "icon-1024.png"

func hex(_ v: UInt32, _ alpha: CGFloat = 1) -> NSColor {
    NSColor(srgbRed: CGFloat((v >> 16) & 0xFF) / 255, green: CGFloat((v >> 8) & 0xFF) / 255,
            blue: CGFloat(v & 0xFF) / 255, alpha: alpha)
}

let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8,
    samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
    bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)

// Tile on the macOS icon grid: 824 px inside the 1024 canvas.
let tile = NSRect(x: 100, y: 100, width: 824, height: 824)
let tilePath = NSBezierPath(roundedRect: tile, xRadius: 185, yRadius: 185)
hex(0x0F1011).setFill()
tilePath.fill()
hex(0xFFFFFF, 0.08).setStroke()
tilePath.lineWidth = 4
tilePath.stroke()

// The menu bar line along the top, then the strip of cards under it.
hex(0xFFFFFF, 0.08).setFill()
NSBezierPath(roundedRect: NSRect(x: 200, y: 684, width: 624, height: 22), xRadius: 11, yRadius: 11).fill()

let dots: [UInt32] = [0x6FA6E8, 0xFB8C00, 0x26A756]
let cardW: CGFloat = 186, cardH: CGFloat = 236, gap: CGFloat = 33
let startX = (CGFloat(size) - (3 * cardW + 2 * gap)) / 2
for i in 0..<3 {
    let x = startX + CGFloat(i) * (cardW + gap)
    let card = NSRect(x: x, y: 396, width: cardW, height: cardH)
    hex(0xFFFFFF, i == 1 ? 0.10 : 0.06).setFill()
    NSBezierPath(roundedRect: card, xRadius: 26, yRadius: 26).fill()
    if i == 1 {
        // The card that needs you gets the warning edge, as in the strip.
        let edge = NSBezierPath(roundedRect: card.insetBy(dx: 3, dy: 3), xRadius: 23, yRadius: 23)
        hex(0xC87619).setStroke()
        edge.lineWidth = 6
        edge.stroke()
    }
    hex(dots[i]).setFill()
    NSBezierPath(ovalIn: NSRect(x: x + 28, y: 396 + cardH - 58, width: 30, height: 30)).fill()
    hex(0xFFFFFF, 0.55).setFill()
    NSBezierPath(roundedRect: NSRect(x: x + 28, y: 396 + cardH - 118, width: 128, height: 20), xRadius: 10, yRadius: 10).fill()
    hex(0xFFFFFF, 0.22).setFill()
    NSBezierPath(roundedRect: NSRect(x: x + 28, y: 396 + cardH - 156, width: 96, height: 16), xRadius: 8, yRadius: 8).fill()
}

// Plan progress under the strip.
for i in 0..<5 {
    let w: CGFloat = 112, g: CGFloat = 16
    let x = startX + CGFloat(i) * (w + g)
    (i < 3 ? hex(0x2D72D2) : hex(0xFFFFFF, 0.10)).setFill()
    NSBezierPath(roundedRect: NSRect(x: x, y: 318, width: w, height: 14), xRadius: 7, yRadius: 7).fill()
}

NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
print("wrote \(out)")
