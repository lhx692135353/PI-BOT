import SwiftUI
import PiBotKit

private func easeOutCubic(_ x: Double) -> Double {
    1.0 - pow(1.0 - x, 3.0)
}

private func easeInOutQuart(_ x: Double) -> Double {
    x < 0.5 ? 8.0 * x * x * x * x : 1.0 - pow(-2.0 * x + 2.0, 4.0) / 2.0
}

/// 竖屏原生 SwiftUI 钢铁侠面甲机械入场动画：
/// 双目点亮 → 方舟反应堆涡轮加速 → 额甲上掀 + 下颌下滑 + 两侧导轨外扩 → 平滑淡出。
struct IronManIntroOverlay: View {
    let onDone: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var startDate = Date()
    @State private var finished = false

    private let duration: TimeInterval = 2.25

    var body: some View {
        TimelineView(.animation) { timeline in
            let elapsed = max(0, timeline.date.timeIntervalSince(startDate))
            let t = min(elapsed / duration, 1.0)
            let fade = t > 0.78 ? max(0, 1.0 - (t - 0.78) / 0.22) : 1.0

            ZStack {
                Canvas { ctx, size in
                    drawFrame(ctx: &ctx, size: size, t: t)
                }
                .ignoresSafeArea()

                VStack(spacing: 4) {
                    Spacer()
                    Text("MARK-OS // STARK HUD")
                        .font(.system(size: 12, weight: .bold))
                        .tracking(2.0)
                        .foregroundStyle(hexColor("#D8B467"))
                    Text("ARMOR SYSTEMS ONLINE")
                        .font(.system(size: 11, weight: .medium))
                        .tracking(1.6)
                        .foregroundStyle(hexColor("#7AEAFF"))
                }
                .padding(.bottom, 52)
                .allowsHitTesting(false)

                VStack {
                    HStack {
                        Spacer()
                        Button("跳过") { complete() }
                            .font(.caption.weight(.medium))
                            .foregroundStyle(hexColor("#D8E7F8"))
                            .padding(.horizontal, 14)
                            .padding(.vertical, 6)
                            .background(hexColor("#101929").opacity(0.82), in: Capsule())
                            .overlay(Capsule().stroke(hexColor("#7AEAFF").opacity(0.35), lineWidth: 1))
                            .padding(.top, 12)
                            .padding(.trailing, 16)
                    }
                    Spacer()
                }
            }
            .opacity(fade)
            .contentShape(Rectangle())
            .onTapGesture { complete() }
            .onChange(of: t >= 1.0) { _, reached in
                if reached { complete() }
            }
        }
        .onAppear {
            if reduceMotion {
                complete()
            } else {
                startDate = Date()
            }
        }
    }

    private func complete() {
        guard !finished else { return }
        finished = true
        onDone()
    }

    private func drawFrame(ctx: inout GraphicsContext, size: CGSize, t: Double) {
        let w = size.width
        let h = size.height
        let cx = w * 0.5
        let cy = h * 0.46

        let bgGrad = Gradient(colors: [hexColor("#131D2E"), hexColor("#070A10"), hexColor("#030508")])
        ctx.fill(
            Path(CGRect(origin: .zero, size: size)),
            with: .radialGradient(bgGrad, center: CGPoint(x: cx, y: cy), startRadius: 0, endRadius: max(w, h) * 0.75)
        )

        let ignite = easeOutCubic(min(max(t / 0.34, 0), 1))
        let openRaw = min(max((t - 0.34) / 0.52, 0), 1)
        let open = easeInOutQuart(openRaw)

        let upperShift = -CGFloat(open) * h * 0.62
        let lowerShift = CGFloat(open) * h * 0.62
        let railShift = CGFloat(open) * w * 0.34

        let crimsonGrad = Gradient(colors: [hexColor("#C2323A"), hexColor("#8C1921"), hexColor("#4F0B10")])
        let crimsonFill = GraphicsContext.Shading.linearGradient(crimsonGrad, startPoint: CGPoint(x: cx, y: 0), endPoint: CGPoint(x: cx, y: h))

        let goldGrad = Gradient(colors: [hexColor("#F6DF9D"), hexColor("#D6B26A"), hexColor("#8C6927")])
        let goldFill = GraphicsContext.Shading.linearGradient(goldGrad, startPoint: CGPoint(x: w * 0.15, y: h * 0.1), endPoint: CGPoint(x: w * 0.85, y: h * 0.9))

        let titaniumGrad = Gradient(colors: [hexColor("#222D40"), hexColor("#101622")])
        let titaniumFill = GraphicsContext.Shading.linearGradient(titaniumGrad, startPoint: CGPoint(x: 0, y: 0), endPoint: CGPoint(x: 0, y: h))

        // 两侧液压导轨
        ctx.fill(Path(CGRect(x: -railShift, y: 0, width: w * 0.12, height: h)), with: titaniumFill)
        ctx.fill(Path(CGRect(x: w * 0.88 + railShift, y: 0, width: w * 0.12, height: h)), with: titaniumFill)

        var railLines = Path()
        railLines.move(to: CGPoint(x: w * 0.12 - railShift, y: 0)); railLines.addLine(to: CGPoint(x: w * 0.12 - railShift, y: h))
        railLines.move(to: CGPoint(x: w * 0.88 + railShift, y: 0)); railLines.addLine(to: CGPoint(x: w * 0.88 + railShift, y: h))
        ctx.stroke(railLines, with: .color(hexColor("#D6B26A").opacity(0.55)), lineWidth: 2)

        // 上半额甲
        var upper = Path()
        upper.move(to: CGPoint(x: 0, y: upperShift))
        upper.addLine(to: CGPoint(x: w, y: upperShift))
        upper.addLine(to: CGPoint(x: w, y: cy + upperShift - h * 0.02))
        upper.addLine(to: CGPoint(x: w * 0.72, y: cy + upperShift + h * 0.04))
        upper.addLine(to: CGPoint(x: w * 0.28, y: cy + upperShift + h * 0.04))
        upper.addLine(to: CGPoint(x: 0, y: cy + upperShift - h * 0.02))
        upper.closeSubpath()
        ctx.fill(upper, with: crimsonFill)

        var upperGold = Path()
        upperGold.move(to: CGPoint(x: w * 0.16, y: upperShift + h * 0.06))
        upperGold.addLine(to: CGPoint(x: w * 0.84, y: upperShift + h * 0.06))
        upperGold.addLine(to: CGPoint(x: w * 0.74, y: cy + upperShift + h * 0.025))
        upperGold.addLine(to: CGPoint(x: w * 0.26, y: cy + upperShift + h * 0.025))
        upperGold.closeSubpath()
        ctx.fill(upperGold, with: goldFill)
        ctx.stroke(upperGold, with: .color(hexColor("#1F1215")), lineWidth: 2.5)

        // 发光双目护目镜
        let eyeY = cy + upperShift - h * 0.085
        let eyeH = h * 0.026
        let leftCenter = CGPoint(x: cx - w * 0.18, y: eyeY)
        let rightCenter = CGPoint(x: cx + w * 0.18, y: eyeY)
        let glowR = w * 0.20
        let eyeGlowGrad = Gradient(colors: [hexColor("#4AD5FF").opacity(0.65 * ignite), .clear])
        ctx.fill(Path(ellipseIn: CGRect(x: leftCenter.x - glowR, y: leftCenter.y - glowR, width: glowR * 2, height: glowR * 2)),
                 with: .radialGradient(eyeGlowGrad, center: leftCenter, startRadius: 0, endRadius: glowR))
        ctx.fill(Path(ellipseIn: CGRect(x: rightCenter.x - glowR, y: rightCenter.y - glowR, width: glowR * 2, height: glowR * 2)),
                 with: .radialGradient(eyeGlowGrad, center: rightCenter, startRadius: 0, endRadius: glowR))

        var eyeL = Path()
        eyeL.move(to: CGPoint(x: cx - w * 0.30, y: eyeY - eyeH * 0.8))
        eyeL.addLine(to: CGPoint(x: cx - w * 0.08, y: eyeY - eyeH * 0.1))
        eyeL.addLine(to: CGPoint(x: cx - w * 0.10, y: eyeY + eyeH * 0.9))
        eyeL.addLine(to: CGPoint(x: cx - w * 0.28, y: eyeY + eyeH * 0.5))
        eyeL.closeSubpath()

        var eyeR = Path()
        eyeR.move(to: CGPoint(x: cx + w * 0.30, y: eyeY - eyeH * 0.8))
        eyeR.addLine(to: CGPoint(x: cx + w * 0.08, y: eyeY - eyeH * 0.1))
        eyeR.addLine(to: CGPoint(x: cx + w * 0.10, y: eyeY + eyeH * 0.9))
        eyeR.addLine(to: CGPoint(x: cx + w * 0.28, y: eyeY + eyeH * 0.5))
        eyeR.closeSubpath()

        let eyeFill = GraphicsContext.Shading.color(hexColor("#8BEFFF").opacity(0.2 + 0.8 * ignite))
        ctx.fill(eyeL, with: eyeFill)
        ctx.fill(eyeR, with: eyeFill)

        // 下半下颌甲
        var lower = Path()
        lower.move(to: CGPoint(x: 0, y: cy + lowerShift - h * 0.01))
        lower.addLine(to: CGPoint(x: w * 0.28, y: cy + lowerShift + h * 0.05))
        lower.addLine(to: CGPoint(x: w * 0.72, y: cy + lowerShift + h * 0.05))
        lower.addLine(to: CGPoint(x: w, y: cy + lowerShift - h * 0.01))
        lower.addLine(to: CGPoint(x: w, y: h + lowerShift))
        lower.addLine(to: CGPoint(x: 0, y: h + lowerShift))
        lower.closeSubpath()
        ctx.fill(lower, with: crimsonFill)

        var jawGold = Path()
        jawGold.move(to: CGPoint(x: w * 0.26, y: cy + lowerShift + h * 0.06))
        jawGold.addLine(to: CGPoint(x: w * 0.74, y: cy + lowerShift + h * 0.06))
        jawGold.addLine(to: CGPoint(x: w * 0.64, y: cy + lowerShift + h * 0.22))
        jawGold.addLine(to: CGPoint(x: w * 0.36, y: cy + lowerShift + h * 0.22))
        jawGold.closeSubpath()
        ctx.fill(jawGold, with: goldFill)
        ctx.stroke(jawGold, with: .color(hexColor("#1F1215")), lineWidth: 2.5)

        // 中央方舟反应堆与涡轮环
        let reactorAlpha = max(0, 1.0 - max(0, (t - 0.52) / 0.34))
        if reactorAlpha > 0.01 {
            let r = min(w, h) * 0.14 * (1.0 + CGFloat(open) * 0.45)
            let reactorGlow = Gradient(colors: [hexColor("#7AF0FF").opacity(0.8 * ignite * reactorAlpha), .clear])
            ctx.fill(
                Path(ellipseIn: CGRect(x: cx - r * 2.1, y: cy - r * 2.1, width: r * 4.2, height: r * 4.2)),
                with: .radialGradient(reactorGlow, center: CGPoint(x: cx, y: cy), startRadius: 0, endRadius: r * 2.1)
            )
            ctx.stroke(
                Path(ellipseIn: CGRect(x: cx - r * 1.12, y: cy - r * 1.12, width: r * 2.24, height: r * 2.24)),
                with: .color(hexColor("#1E2A3D").opacity(reactorAlpha)),
                lineWidth: r * 0.16
            )

            let spin = t * 420.0 * .pi / 180.0
            var teeth = Path()
            for i in 0..<12 {
                let a = Double(i) * (.pi / 6.0) + spin
                teeth.move(to: CGPoint(x: cx + CGFloat(cos(a)) * r * 0.76, y: cy + CGFloat(sin(a)) * r * 0.76))
                teeth.addLine(to: CGPoint(x: cx + CGFloat(cos(a)) * r * 1.02, y: cy + CGFloat(sin(a)) * r * 1.02))
            }
            ctx.stroke(teeth, with: .color(hexColor("#D6B26A").opacity(0.9 * reactorAlpha)), style: StrokeStyle(lineWidth: r * 0.11, lineCap: .round))

            ctx.stroke(
                Path(ellipseIn: CGRect(x: cx - r * 0.62, y: cy - r * 0.62, width: r * 1.24, height: r * 1.24)),
                with: .color(hexColor("#7AEBFF").opacity((0.3 + 0.7 * ignite) * reactorAlpha)),
                lineWidth: r * 0.11
            )
            ctx.fill(
                Path(ellipseIn: CGRect(x: cx - r * 0.36, y: cy - r * 0.36, width: r * 0.72, height: r * 0.72)),
                with: .color(hexColor("#E5FAFF").opacity(ignite * reactorAlpha))
            )
        }
    }
}
