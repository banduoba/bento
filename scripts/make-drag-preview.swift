import AppKit

// 运行：swift scripts/make-drag-preview.swift [输出目录]
// 三个 2× PNG：单文件夹/文件 264×96，多项目 296×96；透明边距容纳轻阴影。
let scriptURL = URL(fileURLWithPath: #filePath)
let outputURL = CommandLine.arguments.count > 1
    ? URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
    : scriptURL.deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("src/assets/drag", isDirectory: true)
try FileManager.default.createDirectory(at: outputURL, withIntermediateDirectories: true)

func makePreview(name: String, width: Int, label: String, stacked: Bool, document: Bool = false) throws {
    let height = 96
    let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
        isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
    )!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    let context = NSGraphicsContext.current!.cgContext
    context.clear(CGRect(x: 0, y: 0, width: width, height: height))
    context.scaleBy(x: 2, y: 2)

    let capsule = NSBezierPath(
        roundedRect: NSRect(x: 4, y: 5, width: CGFloat(width) / 2 - 8, height: 38),
        xRadius: 19, yRadius: 19
    )
    NSGraphicsContext.saveGraphicsState()
    let shadow = NSShadow()
    shadow.shadowColor = NSColor.black.withAlphaComponent(0.24)
    shadow.shadowOffset = NSSize(width: 0, height: -1)
    shadow.shadowBlurRadius = 3
    shadow.set()
    NSColor(calibratedRed: 28 / 255, green: 28 / 255, blue: 32 / 255, alpha: 0.94).setFill()
    capsule.fill()
    NSGraphicsContext.restoreGraphicsState()
    NSColor.white.withAlphaComponent(0.15).setStroke()
    capsule.lineWidth = 0.5
    capsule.stroke()

    if stacked {
        let back = NSBezierPath(roundedRect: NSRect(x: 20, y: 17, width: 24, height: 17), xRadius: 3, yRadius: 3)
        NSColor(calibratedRed: 0.25, green: 0.55, blue: 0.85, alpha: 1).setFill()
        back.fill()
    }
    if document {
        let page = NSBezierPath()
        page.move(to: NSPoint(x: 21, y: 12))
        page.line(to: NSPoint(x: 38, y: 12))
        page.line(to: NSPoint(x: 38, y: 28))
        page.line(to: NSPoint(x: 31, y: 35))
        page.line(to: NSPoint(x: 21, y: 35))
        page.close()
        NSGradient(
            starting: NSColor(calibratedRed: 0.97, green: 0.99, blue: 1, alpha: 1),
            ending: NSColor(calibratedRed: 0.73, green: 0.84, blue: 0.98, alpha: 1)
        )!.draw(in: page, angle: -90)
        let fold = NSBezierPath()
        fold.move(to: NSPoint(x: 31, y: 35))
        fold.line(to: NSPoint(x: 31, y: 28))
        fold.line(to: NSPoint(x: 38, y: 28))
        fold.close()
        NSColor(calibratedRed: 0.54, green: 0.69, blue: 0.88, alpha: 1).setFill()
        fold.fill()
        let lines = NSBezierPath()
        for y in [18, 22, 26] {
            lines.move(to: NSPoint(x: 25, y: y))
            lines.line(to: NSPoint(x: y == 26 ? 29 : 34, y: y))
        }
        NSColor(calibratedRed: 0.29, green: 0.46, blue: 0.68, alpha: 1).setStroke()
        lines.lineWidth = 1
        lines.lineCapStyle = .round
        lines.stroke()
    } else {
        let folder = NSBezierPath()
        folder.move(to: NSPoint(x: 19, y: 15))
        folder.line(to: NSPoint(x: 39, y: 15))
        folder.curve(to: NSPoint(x: 42, y: 18), controlPoint1: NSPoint(x: 41, y: 15), controlPoint2: NSPoint(x: 42, y: 16))
        folder.line(to: NSPoint(x: 42, y: 28))
        folder.curve(to: NSPoint(x: 39, y: 31), controlPoint1: NSPoint(x: 42, y: 30), controlPoint2: NSPoint(x: 41, y: 31))
        folder.line(to: NSPoint(x: 29, y: 31))
        folder.line(to: NSPoint(x: 26, y: 34))
        folder.line(to: NSPoint(x: 19, y: 34))
        folder.curve(to: NSPoint(x: 16, y: 31), controlPoint1: NSPoint(x: 17, y: 34), controlPoint2: NSPoint(x: 16, y: 33))
        folder.line(to: NSPoint(x: 16, y: 18))
        folder.curve(to: NSPoint(x: 19, y: 15), controlPoint1: NSPoint(x: 16, y: 16), controlPoint2: NSPoint(x: 17, y: 15))
        folder.close()
        NSGradient(
            starting: NSColor(calibratedRed: 0.42, green: 0.77, blue: 1, alpha: 1),
            ending: NSColor(calibratedRed: 0.18, green: 0.53, blue: 0.94, alpha: 1)
        )!.draw(in: folder, angle: -90)
        NSColor.white.withAlphaComponent(0.35).setStroke()
        folder.lineWidth = 0.5
        folder.stroke()
    }

    let text = label as NSString
    let attributes: [NSAttributedString.Key: Any] = [
        .font: NSFont.systemFont(ofSize: 13, weight: .medium),
        .foregroundColor: NSColor(calibratedRed: 242 / 255, green: 242 / 255, blue: 246 / 255, alpha: 1)
    ]
    let textHeight = text.size(withAttributes: attributes).height
    text.draw(at: NSPoint(x: 52, y: (48 - textHeight) / 2), withAttributes: attributes)
    NSGraphicsContext.restoreGraphicsState()

    // 绘制完成后再设置 144 dpi，避免 NSGraphicsContext 重复缩放。
    bitmap.size = NSSize(width: CGFloat(width) / 2, height: 48)
    let png = bitmap.representation(using: .png, properties: [:])!
    let url = outputURL.appendingPathComponent(name + ".png")
    try png.write(to: url)
    print("drag preview written: \(url.path) (\(width)×\(height))")
}

try makePreview(name: "1", width: 264, label: "1 个项目", stacked: false)
try makePreview(name: "1-file", width: 264, label: "1 个项目", stacked: false, document: true)
try makePreview(name: "n", width: 296, label: "N 个项目", stacked: true)
