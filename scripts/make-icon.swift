import AppKit

let size: CGFloat = 1024
let image = NSImage(size: NSSize(width: size, height: size))
image.lockFocus()

let rect = NSRect(x: 90, y: 90, width: size - 180, height: size - 180)
let path = NSBezierPath(roundedRect: rect, xRadius: 185, yRadius: 185)
let gradient = NSGradient(
    starting: NSColor(calibratedRed: 0.16, green: 0.56, blue: 1.0, alpha: 1),
    ending: NSColor(calibratedRed: 0.04, green: 0.32, blue: 0.85, alpha: 1)
)!
gradient.draw(in: path, angle: -90)

let para = NSMutableParagraphStyle()
para.alignment = .center
let attrs: [NSAttributedString.Key: Any] = [
    .font: NSFont.systemFont(ofSize: 520),
    .paragraphStyle: para,
]
let s = NSAttributedString(string: "🗂", attributes: attrs)
s.draw(in: NSRect(x: 0, y: size / 2 - 330, width: size, height: 680))

image.unlockFocus()

let tiff = image.tiffRepresentation!
let rep = NSBitmapImageRep(data: tiff)!
let png = rep.representation(using: .png, properties: [:])!
let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "app-icon.png"
try! png.write(to: URL(fileURLWithPath: out))
print("icon written: \(out)")
