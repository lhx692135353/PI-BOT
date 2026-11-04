import SwiftUI

/// Unit space: the body spans roughly -1...1 and is drawn at `size * scale`.
private let unitScale: CGFloat = 0.34
private let centerY: CGFloat = 0.56
private let lightInk = "#F5F5F7"

public enum BotFaceAssets {
    /// Loaded once from the app bundle; tests and previews may replace it.
    nonisolated(unsafe) public static var spec: BotSpec? = BotSpec.bundled()
}

public func hexColor(_ hex: String) -> Color {
    var s = hex.trimmingCharacters(in: .whitespaces)
    if s.hasPrefix("#") { s.removeFirst() }
    let v = UInt64(s, radix: 16) ?? 0
    let (a, r, g, b): (UInt64, UInt64, UInt64, UInt64) = s.count == 8
        ? (v >> 24 & 0xFF, v >> 16 & 0xFF, v >> 8 & 0xFF, v & 0xFF)
        : (0xFF, v >> 16 & 0xFF, v >> 8 & 0xFF, v & 0xFF)
    return Color(.sRGB, red: Double(r) / 255, green: Double(g) / 255, blue: Double(b) / 255, opacity: Double(a) / 255)
}

private final class FaceDriver {
    var engine: BotEngine?
    var seed: Int32 = 0
    var reduceMotion = false
    var last: Date?

    func engine(spec: BotSpec, mood: String, seed: Int32, reduceMotion: Bool) -> BotEngine {
        if let engine, self.seed == seed, self.reduceMotion == reduceMotion { return engine }
        let created = BotEngine(spec: spec, mood: mood, seed: seed, reduceMotion: reduceMotion)
        engine = created; self.seed = seed; self.reduceMotion = reduceMotion; last = nil
        return created
    }

    func advance(to date: Date) {
        guard let engine else { return }
        if let last { engine.step(date.timeIntervalSince(last)) }
        last = date
    }
}

/// Animated Pi Bot character. `paused` renders a still frame (lists with many bots);
/// `seed` keeps confetti and blinking deterministic per bot; `entrance` plays one welcome hop and turn.
public struct BotFace: View {
    let avatar: Avatar
    let mood: String
    let size: CGFloat
    let seed: Int32
    let paused: Bool
    let effects: Bool
    let entrance: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var driver = FaceDriver()

    public init(avatar: Avatar, mood: String, size: CGFloat, seed: Int32 = 1, paused: Bool = false, effects: Bool = true, entrance: Bool = false) {
        self.avatar = avatar; self.mood = mood; self.size = size; self.seed = seed
        self.paused = paused; self.effects = effects; self.entrance = entrance
    }

    public var body: some View {
        Group {
            if let spec = BotFaceAssets.spec {
                let engine = driver.engine(spec: spec, mood: mood, seed: seed, reduceMotion: reduceMotion)
                let look = avatar.normalized()
                let still = paused || reduceMotion
                TimelineView(.animation(paused: still)) { context in
                    Canvas { ctx, canvasSize in
                        engine.setMood(mood)
                        if still { engine.step(0) } else { driver.advance(to: context.date) }
                        drawBot(ctx, spec: spec, frame: engine.frame(), avatar: look, size: min(canvasSize.width, canvasSize.height), effects: effects)
                    }
                }
                .onAppear {
                    if entrance && !paused { engine.bounce(); engine.spin() }
                }
            } else {
                Color.clear
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

private func ellipse(_ cx: Double, _ cy: Double, _ rx: Double, _ ry: Double) -> Path {
    Path(ellipseIn: CGRect(x: cx - rx, y: cy - ry, width: rx * 2, height: ry * 2))
}

private func round(_ width: Double) -> StrokeStyle { StrokeStyle(lineWidth: width, lineCap: .round, lineJoin: .round) }

/// Port of `drawBot` in `packages/bot-face/src/render.ts`.
public func drawBot(_ base: GraphicsContext, spec: BotSpec, frame: Frame, avatar: Avatar, size: CGFloat, effects: Bool = true) {
    let shape = spec.shape(avatar.shape)
    let color = spec.color(avatar.color)
    let mood = spec.mood(frame.mood)
    let pair = (avatar.scheme == "dark" ? color.dark : color.light).map(hexColor)
    let top = pair[0], bottom = pair[1]
    let ink = hexColor(color.ink)
    let isLightInk = color.ink == lightInk
    let t = frame.t

    var ctx = base
    ctx.translateBy(x: size / 2, y: size * centerY)
    ctx.scaleBy(x: size * unitScale, y: size * unitScale)

    let lift = min(0.5, abs(frame.offsetY) * 3)
    ctx.fill(ellipse(0, 0.98, 0.62 * (1 - lift), 0.075 * (1 - lift)), with: .color(.black.opacity(0.12)))

    var body = ctx
    body.translateBy(x: 0, y: frame.offsetY)
    body.rotate(by: .radians(frame.rotation))
    body.translateBy(x: 0, y: 0.8)
    body.scaleBy(x: frame.scaleX, y: frame.scaleY)
    body.translateBy(x: 0, y: -0.8)

    for side in [-1.0, 1.0] { body.fill(ellipse(side * 0.32, 0.84, 0.17, 0.1), with: .color(bottom)) }
    if mood.arms != "hidden" {
        for side in [-1, 1] {
            let a = armAngle(mood.arms, side: side, t: t)
            let s = Double(side)
            let sx = s * 0.68, sy = 0.18
            var arm = Path()
            arm.move(to: CGPoint(x: sx, y: sy))
            arm.addLine(to: CGPoint(x: sx + s * sin(a) * 0.34, y: sy + cos(a) * 0.34))
            body.stroke(arm, with: .color(bottom), style: StrokeStyle(lineWidth: 0.2, lineCap: .round))
        }
    }

    let outline = smoothOutline(shape.points)
    var hull = Path()
    hull.move(to: CGPoint(x: outline.start.x, y: outline.start.y))
    for s in outline.segments {
        hull.addCurve(to: CGPoint(x: s.end.x, y: s.end.y), control1: CGPoint(x: s.c1.x, y: s.c1.y), control2: CGPoint(x: s.c2.x, y: s.c2.y))
    }
    hull.closeSubpath()
    body.fill(hull, with: .linearGradient(Gradient(colors: [top, bottom]), startPoint: CGPoint(x: 0, y: -0.95), endPoint: CGPoint(x: 0, y: 0.9)))

    var shine = body
    shine.translateBy(x: -0.34, y: -0.46)
    shine.rotate(by: .radians(-0.55))
    shine.fill(ellipse(0, 0, 0.22, 0.12), with: .color(.white.opacity(0.26)))

    let face = shape.face
    let cheek = hexColor(color.cheek)
    for side in [-1.0, 1.0] { body.fill(ellipse(side * (face.gap / 2 + 0.13), face.y + 0.17, 0.1, 0.06), with: .color(cheek.opacity(0.45))) }

    let gx = frame.gazeX * 0.06
    let gy = frame.gazeY * 0.05
    for side in [-1.0, 1.0] {
        let style = mood.eyes == "wink" ? (side < 0 ? "open" : "happy") : mood.eyes
        drawEye(body, style: style, x: side * (face.gap / 2) + gx, y: face.y + gy, e: face.eye, blink: frame.blink, ink: ink, lightInk: isLightInk)
    }
    drawMouth(body, style: mood.mouth, x: gx * 0.5, y: face.y + 0.2 + gy * 0.5, ink: ink)

    if effects { drawEffect(ctx, effect: mood.effect, t: t, lightInk: isLightInk, accent: bottom) }
    for p in frame.particles {
        var piece = ctx
        piece.translateBy(x: p.x, y: p.y)
        piece.rotate(by: .radians(p.rotation))
        let confetti = hexColor(spec.confetti[p.color % spec.confetti.count])
        piece.fill(Path(CGRect(x: -0.035, y: -0.018, width: 0.07, height: 0.036)), with: .color(confetti.opacity(min(1, p.life / 0.4))))
    }
}

private func drawEye(_ ctx: GraphicsContext, style: String, x: Double, y: Double, e: Double, blink: Double, ink: Color, lightInk: Bool) {
    let open = 1 - blink * 0.9
    switch style {
    case "happy":
        var p = Path()
        p.move(to: CGPoint(x: x - e * 0.75, y: y + e * 0.25))
        p.addQuadCurve(to: CGPoint(x: x + e * 0.75, y: y + e * 0.25), control: CGPoint(x: x, y: y - e * 0.9))
        ctx.stroke(p, with: .color(ink), style: round(e * 0.38))
    case "closed":
        var p = Path()
        p.move(to: CGPoint(x: x - e * 0.8, y: y - e * 0.1))
        p.addQuadCurve(to: CGPoint(x: x + e * 0.8, y: y - e * 0.1), control: CGPoint(x: x, y: y + e * 0.75))
        ctx.stroke(p, with: .color(ink), style: round(e * 0.38))
    case "small":
        ctx.fill(ellipse(x, y, e * 0.42, e * 0.48 * open), with: .color(ink))
    default:
        let ry = e * (style == "focus" ? 0.6 : 1.0) * open
        ctx.fill(ellipse(x, y, e * 0.72, max(ry, e * 0.08)), with: .color(ink))
        if blink < 0.5 && !lightInk {
            ctx.fill(ellipse(x + e * 0.22, y - ry * 0.38, e * 0.2, e * 0.2), with: .color(.white.opacity(0.9)))
        }
    }
}

private func drawMouth(_ ctx: GraphicsContext, style: String, x: Double, y: Double, ink: Color) {
    var p = Path()
    switch style {
    case "open":
        p.move(to: CGPoint(x: x - 0.11, y: y - 0.02))
        p.addQuadCurve(to: CGPoint(x: x + 0.11, y: y - 0.02), control: CGPoint(x: x, y: y + 0.17))
        p.closeSubpath()
        ctx.fill(p, with: .color(ink))
        ctx.fill(ellipse(x, y + 0.055, 0.045, 0.022), with: .color(hexColor("#FF7A85")))
    case "flat":
        p.move(to: CGPoint(x: x - 0.07, y: y + 0.02))
        p.addLine(to: CGPoint(x: x + 0.07, y: y + 0.02))
        ctx.stroke(p, with: .color(ink), style: round(0.034))
    case "o":
        ctx.fill(ellipse(x, y + 0.03, 0.045, 0.055), with: .color(ink))
    case "frown":
        p.move(to: CGPoint(x: x - 0.08, y: y + 0.05))
        p.addQuadCurve(to: CGPoint(x: x + 0.08, y: y + 0.05), control: CGPoint(x: x, y: y - 0.03))
        ctx.stroke(p, with: .color(ink), style: round(0.034))
    default:
        p.move(to: CGPoint(x: x - 0.09, y: y - 0.01))
        p.addQuadCurve(to: CGPoint(x: x + 0.09, y: y - 0.01), control: CGPoint(x: x, y: y + 0.08))
        ctx.stroke(p, with: .color(ink), style: round(0.034))
    }
}

private func drawEffect(_ ctx: GraphicsContext, effect: String, t: Double, lightInk: Bool, accent: Color) {
    switch effect {
    case "dots":
        for i in 0..<3 {
            let d = Double(i)
            let alpha = 0.25 + 0.75 * max(0, sin(t * 4 - d * 0.8))
            let r = 0.045 + d * 0.012
            ctx.fill(ellipse(0.6 + d * 0.15, -0.95 - d * 0.06, r, r), with: .color(hexColor("#8A8F98").opacity(alpha)))
        }
    case "question":
        let y = -1.0 + sin(t * 3) * 0.04
        let r = 0.11
        var p = Path()
        p.addArc(center: CGPoint(x: 0.8, y: y), radius: r, startAngle: .degrees(198), endAngle: .degrees(198 + 225), clockwise: false)
        p.addLine(to: CGPoint(x: 0.8, y: y + 0.2))
        ctx.stroke(p, with: .color(accent), style: round(0.07))
        ctx.fill(ellipse(0.8, y + 0.32, 0.04, 0.04), with: .color(accent))
    case "alert":
        let y = -1.05 + sin(t * 6) * 0.025
        let red = hexColor("#F04438")
        var p = Path()
        p.move(to: CGPoint(x: 0.8, y: y))
        p.addLine(to: CGPoint(x: 0.8, y: y + 0.24))
        ctx.stroke(p, with: .color(red), style: StrokeStyle(lineWidth: 0.08, lineCap: .round))
        ctx.fill(ellipse(0.8, y + 0.37, 0.045, 0.045), with: .color(red))
    case "zzz":
        let c = hexColor(lightInk ? "#9CA3AF" : "#6B7280")
        for i in 0..<3 {
            let phase = (t * 0.45 + Double(i) / 3).truncatingRemainder(dividingBy: 1)
            let s = 0.08 + phase * 0.08
            let x = 0.5 + phase * 0.38
            let y = -0.72 - phase * 0.5
            var z = Path()
            z.move(to: CGPoint(x: x - s, y: y - s))
            z.addLine(to: CGPoint(x: x + s, y: y - s))
            z.addLine(to: CGPoint(x: x - s, y: y + s))
            z.addLine(to: CGPoint(x: x + s, y: y + s))
            ctx.stroke(z, with: .color(c.opacity(sin(phase * Double.pi))), style: round(0.035))
        }
    case "sparkle":
        let spots: [(Double, Double)] = [(-0.85, -0.75), (0.88, -0.6), (0.6, -1.02)]
        for i in 0..<3 {
            let s = 0.05 + 0.04 * max(0, sin(t * 5 + Double(i) * 2.1))
            let (x, y) = spots[i]
            var star = Path()
            star.move(to: CGPoint(x: x, y: y - s * 2))
            star.addQuadCurve(to: CGPoint(x: x + s * 2, y: y), control: CGPoint(x: x, y: y))
            star.addQuadCurve(to: CGPoint(x: x, y: y + s * 2), control: CGPoint(x: x, y: y))
            star.addQuadCurve(to: CGPoint(x: x - s * 2, y: y), control: CGPoint(x: x, y: y))
            star.addQuadCurve(to: CGPoint(x: x, y: y - s * 2), control: CGPoint(x: x, y: y))
            ctx.fill(star, with: .color(hexColor("#FFD166")))
        }
    default:
        break
    }
}
