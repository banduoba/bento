import AppKit

// Bento 应用图标：深蓝渐变底 + 白色窗口四格（一格强调色），多窗格管理器意象
let size: CGFloat = 1024
let image = NSImage(size: NSSize(width: size, height: size))
image.lockFocus()

// 背景：圆角矩形，蓝色渐变
let rect = NSRect(x: 90, y: 90, width: size - 180, height: size - 180)
let bg = NSBezierPath(roundedRect: rect, xRadius: 185, yRadius: 185)
let bgGrad = NSGradient(
    starting: NSColor(calibratedRed: 0.12, green: 0.52, blue: 1.0, alpha: 1),
    ending: NSColor(calibratedRed: 0.03, green: 0.26, blue: 0.72, alpha: 1)
)!
bgGrad.draw(in: bg, angle: -90)

// 白色窗口：居中圆角矩形
let winRect = NSRect(x: 212, y: 232, width: 600, height: 560)
let win = NSBezierPath(roundedRect: winRect, xRadius: 56, yRadius: 56)
NSColor.white.setFill()
win.fill()

// 四格：左上为强调蓝渐变，其余浅灰
let pad: CGFloat = 34
let gridX = winRect.minX + pad
let gridY = winRect.minY + pad
let gridW = winRect.width - pad * 2
let gridH = winRect.height - pad * 2 - 56 // 底部留白当"状态栏"
let gap: CGFloat = 22
let cellW = (gridW - gap) / 2
let cellH = (gridH - gap) / 2

let cells: [(NSRect, Bool)] = [
    (NSRect(x: gridX, y: gridY + cellH + gap, width: cellW, height: cellH), true), // 左上强调
    (NSRect(x: gridX + cellW + gap, y: gridY + cellH + gap, width: cellW, height: cellH), false),
    (NSRect(x: gridX, y: gridY, width: cellW, height: cellH), false),
    (NSRect(x: gridX + cellW + gap, y: gridY, width: cellW, height: cellH), false),
]

for (r, accent) in cells {
    let cell = NSBezierPath(roundedRect: r, xRadius: 24, yRadius: 24)
    if accent {
        let g = NSGradient(
            starting: NSColor(calibratedRed: 0.95, green: 0.45, blue: 0.25, alpha: 1),
            ending: NSColor(calibratedRed: 0.98, green: 0.62, blue: 0.18, alpha: 1)
        )!
        g.draw(in: cell, angle: -90)
    } else {
        NSColor(calibratedWhite: 0.88, alpha: 1).setFill()
        cell.fill()
    }
}

// 底部状态条（呼应真实 UI 的状态栏）
let bar = NSBezierPath(roundedRect: NSRect(x: gridX, y: winRect.minY + pad - 34, width: gridW, height: 20), xRadius: 10, yRadius: 10)
NSColor(calibratedWhite: 0.78, alpha: 1).setFill()
bar.fill()

image.unlockFocus()

let tiff = image.tiffRepresentation!
let rep = NSBitmapImageRep(data: tiff)!
let png = rep.representation(using: .png, properties: [:])!
let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "app-icon.png"
try! png.write(to: URL(fileURLWithPath: out))
print("icon written: \(out)")
