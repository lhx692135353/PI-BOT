import SwiftUI
import PiBotKit

struct IronManAvatarView: View {
    let seed: String
    var mood: String = "idle"
    var size: CGFloat = 48
    var armorIndex: Int? = nil

    private var armor: ArmorSpec {
        if let idx = armorIndex, armorModels.indices.contains(idx) {
            return armorModels[idx]
        }
        return armorSpec(for: seed)
    }

    var body: some View {
        let spec = armor
        Canvas { ctx, canvasSize in
            let w = canvasSize.width
            let h = canvasSize.height
            let u = min(w, h) / 100
            func pt(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: w * x / 100, y: h * y / 100) }

            let isWide = spec.variant == .mk44 || spec.variant == .mk17
            let isNano = spec.variant == .mk50 || spec.variant == .mk85
            let isStriped = spec.variant == .mk5
            let isSharp = spec.variant == .mk6 || spec.variant == .mk33
            let isTactical = spec.variant == .wm4 || spec.variant == .mk7
            let isSpace = spec.variant == .mk39
            let isSplit = spec.variant == .mk42

            let eyeColor: Color = mood == "error" ? hexColor("#FF5B5B") : mood == "waiting" ? hexColor("#FFC154") : spec.eyeColor
            let eyeGlow: Color = mood == "error" ? hexColor("#FF2B2B") : mood == "waiting" ? hexColor("#FF9F1C") : spec.eyeGlow
            let eyeOpacity: Double = mood == "sleeping" ? 0.35 : (mood == "working" || mood == "thinking" || mood == "error" || mood == "waiting" ? 1.0 : 0.9)
            let eyeScaleY: CGFloat = mood == "sleeping" ? 0.55 : 1.0

            // 深海钛圆底 + 金属圈
            let outerRect = CGRect(x: 3 * u, y: 3 * u, width: 94 * u, height: 94 * u)
            let bgGrad = Gradient(colors: [hexColor("#1B2638"), hexColor("#0F1521"), hexColor("#080B12")])
            ctx.fill(Path(ellipseIn: outerRect), with: .radialGradient(bgGrad, center: pt(35, 25), startRadius: 0, endRadius: 75 * u))
            ctx.stroke(Path(ellipseIn: outerRect), with: .color(spec.faceplate.opacity(0.5)), lineWidth: 1.8 * u)

            let ringRect = CGRect(x: 6.5 * u, y: 6.5 * u, width: 87 * u, height: 87 * u)
            ctx.stroke(
                Path(ellipseIn: ringRect),
                with: .color(eyeGlow.opacity(0.28)),
                style: StrokeStyle(lineWidth: 0.9 * u, dash: isTactical ? [6 * u, 3 * u] : [14 * u, 6 * u])
            )

            let shellGrad = Gradient(colors: [spec.primaryBright, spec.primary, spec.primaryDark])
            let faceGrad = Gradient(colors: [spec.faceplateBright, spec.faceplate, spec.faceplateDark])
            let specGrad = Gradient(colors: [.white.opacity(0.42), .white.opacity(0.05), .black.opacity(0.2)])
            let shellFill = GraphicsContext.Shading.linearGradient(shellGrad, startPoint: pt(15, 6), endPoint: pt(85, 94))
            let faceFill = GraphicsContext.Shading.linearGradient(faceGrad, startPoint: pt(18, 10), endPoint: pt(82, 90))
            let specFill = GraphicsContext.Shading.linearGradient(specGrad, startPoint: pt(20, 10), endPoint: pt(80, 80))

            // 重装护耳块
            if isWide || isTactical {
                var leftEar = Path()
                leftEar.move(to: pt(12, 42)); leftEar.addLine(to: pt(20, 35)); leftEar.addLine(to: pt(20, 63)); leftEar.addLine(to: pt(12, 58)); leftEar.closeSubpath()
                var rightEar = Path()
                rightEar.move(to: pt(88, 42)); rightEar.addLine(to: pt(80, 35)); rightEar.addLine(to: pt(80, 63)); rightEar.addLine(to: pt(88, 58)); rightEar.closeSubpath()
                ctx.fill(leftEar, with: shellFill)
                ctx.stroke(leftEar, with: .color(spec.trim), lineWidth: 1.2 * u)
                ctx.fill(rightEar, with: shellFill)
                ctx.stroke(rightEar, with: .color(spec.trim), lineWidth: 1.2 * u)
            }

            // 外壳头盔
            var helmet = Path()
            if isSharp {
                helmet.move(to: pt(50, 10))
                helmet.addLine(to: pt(75, 21)); helmet.addLine(to: pt(82, 46)); helmet.addLine(to: pt(76, 72))
                helmet.addLine(to: pt(62, 88)); helmet.addLine(to: pt(50, 91)); helmet.addLine(to: pt(38, 88))
                helmet.addLine(to: pt(24, 72)); helmet.addLine(to: pt(18, 46)); helmet.addLine(to: pt(25, 21))
                helmet.closeSubpath()
            } else {
                let side: CGFloat = isWide ? 85 : 81
                let left = 100 - side
                let jaw: CGFloat = isWide ? 81 : 77
                let jawL = 100 - jaw
                helmet.move(to: pt(50, 10.5))
                helmet.addCurve(to: pt(side, 44), control1: pt(69, 10.5), control2: pt(side - 1, 23))
                helmet.addLine(to: pt(jaw, 71))
                helmet.addCurve(to: pt(50, 90), control1: pt(jaw - 4, 83), control2: pt(63, 89))
                helmet.addCurve(to: pt(jawL, 71), control1: pt(37, 89), control2: pt(jawL + 4, 83))
                helmet.addLine(to: pt(left, 44))
                helmet.addCurve(to: pt(50, 10.5), control1: pt(left + 1, 23), control2: pt(31, 10.5))
                helmet.closeSubpath()
            }
            ctx.fill(helmet, with: shellFill)
            ctx.stroke(helmet, with: .color(spec.trim), style: StrokeStyle(lineWidth: 1.8 * u, lineJoin: .round))

            // 额冠高光
            var crown = Path()
            crown.move(to: pt(36, 14)); crown.addLine(to: pt(50, 11)); crown.addLine(to: pt(64, 14))
            crown.addLine(to: pt(59, 29)); crown.addLine(to: pt(41, 29)); crown.closeSubpath()
            ctx.fill(crown, with: specFill)

            if isSpace {
                var band = Path()
                band.move(to: pt(31, 20)); band.addLine(to: pt(69, 20)); band.addLine(to: pt(65, 28)); band.addLine(to: pt(35, 28)); band.closeSubpath()
                ctx.fill(band, with: .color(spec.trim.opacity(0.65)))
            }

            // 面甲主件
            let topOuter: CGFloat = isWide ? 32 : (isNano ? 35 : 34)
            let midOuter: CGFloat = isWide ? 76 : 74
            var face = Path()
            face.move(to: pt(topOuter, 27)); face.addLine(to: pt(43, 32)); face.addLine(to: pt(57, 32))
            face.addLine(to: pt(100 - topOuter, 27)); face.addLine(to: pt(midOuter, 45)); face.addLine(to: pt(69, 68))
            face.addLine(to: pt(60, 80)); face.addLine(to: pt(56, 75)); face.addLine(to: pt(44, 75))
            face.addLine(to: pt(40, 80)); face.addLine(to: pt(31, 68)); face.addLine(to: pt(100 - midOuter, 45))
            face.closeSubpath()
            ctx.fill(face, with: faceFill)
            ctx.stroke(face, with: .color(spec.trim), style: StrokeStyle(lineWidth: 1.5 * u, lineJoin: .round))

            // 额头嵌块
            var forehead = Path()
            forehead.move(to: pt(42, 21)); forehead.addLine(to: pt(58, 21)); forehead.addLine(to: pt(55, 34)); forehead.addLine(to: pt(45, 34)); forehead.closeSubpath()
            ctx.fill(forehead, with: shellFill)
            ctx.stroke(forehead, with: .color(spec.trim), lineWidth: 1.2 * u)

            // 鼻梁高光 + 颧骨折线
            var nose = Path()
            nose.move(to: pt(45, 34)); nose.addLine(to: pt(55, 34)); nose.addLine(to: pt(53, 64)); nose.addLine(to: pt(47, 64)); nose.closeSubpath()
            ctx.fill(nose, with: specFill)

            var cheekL = Path(); cheekL.move(to: pt(27, 49)); cheekL.addLine(to: pt(39, 58)); cheekL.addLine(to: pt(39, 74))
            var cheekR = Path(); cheekR.move(to: pt(73, 49)); cheekR.addLine(to: pt(61, 58)); cheekR.addLine(to: pt(61, 74))
            ctx.stroke(cheekL, with: .color(spec.trim.opacity(0.65)), lineWidth: 1.2 * u)
            ctx.stroke(cheekR, with: .color(spec.trim.opacity(0.65)), lineWidth: 1.2 * u)

            // 型号专属细节
            if isStriped {
                var stripes = Path()
                stripes.move(to: pt(29, 38)); stripes.addLine(to: pt(39, 41))
                stripes.move(to: pt(71, 38)); stripes.addLine(to: pt(61, 41))
                stripes.move(to: pt(30, 60)); stripes.addLine(to: pt(39, 63))
                stripes.move(to: pt(70, 60)); stripes.addLine(to: pt(61, 63))
                ctx.stroke(stripes, with: .color(spec.primary.opacity(0.75)), lineWidth: 1.5 * u)
            }
            if isSplit {
                var split = Path(); split.move(to: pt(50, 34)); split.addLine(to: pt(50, 65))
                ctx.stroke(split, with: .color(spec.faceplateBright.opacity(0.65)), lineWidth: 1.1 * u)
            }
            if isNano {
                var nano = Path()
                nano.move(to: pt(37, 30)); nano.addLine(to: pt(42, 36))
                nano.move(to: pt(63, 30)); nano.addLine(to: pt(58, 36))
                nano.move(to: pt(46, 66)); nano.addLine(to: pt(54, 66))
                ctx.stroke(nano, with: .color(eyeGlow.opacity(0.72)), lineWidth: 1.1 * u)
            }
            if isTactical {
                ctx.fill(Path(roundedRect: CGRect(x: 44 * u, y: 24 * u, width: 12 * u, height: 3 * u), cornerRadius: 1 * u), with: .color(eyeColor.opacity(0.65)))
            }

            // 下颌与口缝
            var chin = Path()
            chin.move(to: pt(39, 71)); chin.addLine(to: pt(45, 73)); chin.addLine(to: pt(55, 73)); chin.addLine(to: pt(61, 71))
            chin.addLine(to: pt(58, 84)); chin.addLine(to: pt(42, 84)); chin.closeSubpath()
            ctx.fill(chin, with: shellFill)
            ctx.stroke(chin, with: .color(spec.trim), lineWidth: 1.2 * u)

            var mouth = Path()
            mouth.move(to: pt(41, 75)); mouth.addLine(to: pt(46, 77)); mouth.addLine(to: pt(54, 77)); mouth.addLine(to: pt(59, 75))
            ctx.stroke(mouth, with: .color(spec.trim), style: StrokeStyle(lineWidth: 1.6 * u, lineCap: .round))

            // 眼部辉光
            let glowGrad = Gradient(colors: [eyeGlow.opacity(0.65 * eyeOpacity), .clear])
            let leftGlowRect = CGRect(x: 26.5 * u, y: 37.8 * u, width: 22 * u, height: 22 * u)
            let rightGlowRect = CGRect(x: 51.5 * u, y: 37.8 * u, width: 22 * u, height: 22 * u)
            ctx.fill(Path(ellipseIn: leftGlowRect), with: .radialGradient(glowGrad, center: pt(37.5, 48.8), startRadius: 0, endRadius: 11 * u))
            ctx.fill(Path(ellipseIn: rightGlowRect), with: .radialGradient(glowGrad, center: pt(62.5, 48.8), startRadius: 0, endRadius: 11 * u))

            // 眼窝暗槽
            var socketL = Path(); socketL.move(to: pt(29.5, 45.5)); socketL.addLine(to: pt(45, 48.2)); socketL.addLine(to: pt(43, 52.2)); socketL.addLine(to: pt(31.2, 50.8)); socketL.closeSubpath()
            var socketR = Path(); socketR.move(to: pt(70.5, 45.5)); socketR.addLine(to: pt(55, 48.2)); socketR.addLine(to: pt(57, 52.2)); socketR.addLine(to: pt(68.8, 50.8)); socketR.closeSubpath()
            ctx.fill(socketL, with: .color(hexColor("#090D14")))
            ctx.fill(socketR, with: .color(hexColor("#090D14")))

            // 发光护目镜
            let halfH: CGFloat = 1.6 * eyeScaleY
            var eyeL = Path()
            eyeL.move(to: pt(31.2, 48.2 - halfH)); eyeL.addLine(to: pt(44.2, 49.6 - halfH * 0.7))
            eyeL.addLine(to: pt(42.8, 49.8 + halfH)); eyeL.addLine(to: pt(32.2, 48.6 + halfH)); eyeL.closeSubpath()
            var eyeR = Path()
            eyeR.move(to: pt(68.8, 48.2 - halfH)); eyeR.addLine(to: pt(55.8, 49.6 - halfH * 0.7))
            eyeR.addLine(to: pt(57.2, 49.8 + halfH)); eyeR.addLine(to: pt(67.8, 48.6 + halfH)); eyeR.closeSubpath()
            ctx.fill(eyeL, with: .color(eyeColor.opacity(eyeOpacity)))
            ctx.fill(eyeR, with: .color(eyeColor.opacity(eyeOpacity)))

            var coreL = Path(); coreL.move(to: pt(33, 48.2)); coreL.addLine(to: pt(42.5, 49.5))
            var coreR = Path(); coreR.move(to: pt(67, 48.2)); coreR.addLine(to: pt(57.5, 49.5))
            ctx.stroke(coreL, with: .color(.white.opacity(0.85 * eyeOpacity)), style: StrokeStyle(lineWidth: 1.0 * u, lineCap: .round))
            ctx.stroke(coreR, with: .color(.white.opacity(0.85 * eyeOpacity)), style: StrokeStyle(lineWidth: 1.0 * u, lineCap: .round))
        }
        .frame(width: size, height: size)
    }
}
