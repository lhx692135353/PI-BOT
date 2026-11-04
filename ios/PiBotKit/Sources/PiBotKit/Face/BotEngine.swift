import Foundation

/// Mulberry32, bit-for-bit identical to `rng` in `packages/bot-face/src/engine.ts`.
public struct Mulberry32 {
    private var a: UInt32

    public init(seed: Int32) { a = UInt32(bitPattern: seed) }

    public mutating func next() -> Double {
        a &+= 0x6D2B79F5
        var t = a
        t = (t ^ (t >> 15)) &* (t | 1)
        t ^= t &+ ((t ^ (t >> 7)) &* (t | 61))
        return Double(t ^ (t >> 14)) / 4294967296.0
    }
}

public struct Particle: Sendable {
    public var x, y, vx, vy, rotation: Double
    public let spin: Double
    public var life: Double
    public let maxLife: Double
    public let color: Int
}

public struct Frame: Sendable {
    public let t: Double
    public let mood: String
    /// 0 = open, 1 = fully closed.
    public let blink: Double
    public let gazeX, gazeY, scaleX, scaleY, offsetY, rotation: Double
    public let particles: [Particle]
}

private let blinkSeconds = 0.16
private let maxParticles = 80
private let blinkingEyes: Set<String> = ["open", "focus", "small", "wink"]

func clamp(_ v: Double, _ lo: Double, _ hi: Double) -> Double { v < lo ? lo : (v > hi ? hi : v) }

/// Line-by-line port of `BotEngine` so every platform animates identically for the same seed.
public final class BotEngine {
    private let spec: BotSpec
    private let reduceMotion: Bool
    private var t = 0.0
    public private(set) var mood: String
    private var random: Mulberry32
    private var nextBlink: Double
    private var blinkPhase = -1.0
    private var gazeX = 0.0, gazeY = 0.0, gazeVx = 0.0, gazeVy = 0.0
    private var pointer: (Double, Double)?
    private var hopY = 0.0, hopV = 0.0
    private var spinLeft = 0.0
    private var angle = 0.0
    private var particles: [Particle] = []
    private var spawnDebt = 0.0

    public init(spec: BotSpec, mood: String? = nil, seed: Int32 = 1, reduceMotion: Bool = false) {
        self.spec = spec
        self.mood = mood ?? spec.defaults.mood
        self.reduceMotion = reduceMotion
        random = Mulberry32(seed: seed)
        nextBlink = 0
        nextBlink = 1.5 + random.next() * 2
    }

    public func setMood(_ next: String) {
        if next == mood { return }
        mood = next
        if next == "celebrate" { bounce(); burst() }
        else if next == "happy" { bounce() }
    }

    /// Pointer in unit space (-1...1); nil re-centers the eyes.
    public func look(_ x: Double?, _ y: Double?) {
        if let x, let y { pointer = (clamp(x, -1, 1), clamp(y, -1, 1)) } else { pointer = nil }
    }

    public func bounce() { if !reduceMotion { hopV = -2.4 } }

    public func spin(_ turns: Double = 1) { if !reduceMotion && spinLeft <= 0 { spinLeft = turns } }

    public func burst(_ count: Int = 26) {
        if reduceMotion { return }
        for _ in 0..<count { spawn(burst: true) }
    }

    private func spawn(burst: Bool) {
        if particles.count >= maxParticles { return }
        let angle = burst ? -Double.pi / 2 + (random.next() - 0.5) * Double.pi * 1.4 : 0
        let speed = burst ? 1.6 + random.next() * 1.6 : 0
        let maxLife = 1.2 + random.next() * 1.2
        let x = burst ? (random.next() - 0.5) * 0.4 : (random.next() - 0.5) * 2.4
        let y = burst ? -0.4 : -1.25
        let vx = burst ? cos(angle) * speed : (random.next() - 0.5) * 0.3
        let vy = burst ? sin(angle) * speed : 0.3 + random.next() * 0.4
        let rotation = random.next() * Double.pi * 2
        let spin = (random.next() - 0.5) * 10
        let color = Int(floor(random.next() * Double(spec.confetti.count)))
        particles.append(Particle(x: x, y: y, vx: vx, vy: vy, rotation: rotation, spin: spin, life: maxLife, maxLife: maxLife, color: color))
    }

    public func step(_ delta: Double) {
        let dt = clamp(delta, 0, 0.1)
        t += dt
        let style = spec.mood(mood)
        if !reduceMotion && blinkingEyes.contains(style.eyes) {
            nextBlink -= dt
            if nextBlink <= 0 && blinkPhase < 0 {
                blinkPhase = 0
                nextBlink = 2.4 + random.next() * 3.2
            }
        }
        if blinkPhase >= 0 {
            blinkPhase += dt / blinkSeconds
            if blinkPhase > 1 { blinkPhase = -1 }
        }
        let (tx, ty) = gazeTarget()
        let k = 60.0, d = 12.0
        gazeVx += ((tx - gazeX) * k - gazeVx * d) * dt
        gazeVy += ((ty - gazeY) * k - gazeVy * d) * dt
        gazeX += gazeVx * dt
        gazeY += gazeVy * dt
        hopV += (-hopY * 220 - hopV * 14) * dt
        hopY += hopV * dt
        if spinLeft > 0 {
            let turn = dt * 1.6
            spinLeft -= turn
            angle += turn * Double.pi * 2
            if spinLeft <= 0 { angle = 0 }
        }
        if style.effect == "confetti" && !reduceMotion {
            spawnDebt += dt * 14
            while spawnDebt >= 1 {
                spawn(burst: false)
                spawnDebt -= 1
            }
        }
        for i in particles.indices {
            particles[i].vy += 2.2 * dt
            particles[i].vx *= 1 - 0.6 * dt
            particles[i].x += particles[i].vx * dt
            particles[i].y += particles[i].vy * dt
            particles[i].rotation += particles[i].spin * dt
            particles[i].life -= dt
        }
        particles.removeAll { !($0.life > 0 && $0.y < 1.6) }
    }

    private func gazeTarget() -> (Double, Double) {
        switch mood {
        case "searching": return (sin(t * 2.4) * 0.9, 0.1)
        case "thinking": return (0.55, -0.65)
        case "working": return (0, 0.45)
        case "sleeping": return (0, 0)
        default:
            if let pointer { return pointer }
            if reduceMotion { return (0, 0) }
            return (sin(t * 0.37) * 0.18, sin(t * 0.23) * 0.08)
        }
    }

    public func frame() -> Frame {
        let motion = reduceMotion ? 0.0 : 1.0
        let breathe = sin((t * Double.pi * 2) / (mood == "sleeping" ? 4 : 3))
        let amp = mood == "sleeping" ? 0.035 : 0.02
        var offsetY = hopY * 0.12
        switch mood {
        case "celebrate": offsetY += -abs(sin(t * 5.5)) * 0.07 * motion
        case "working": offsetY += sin(t * 18) * 0.008 * motion
        default: offsetY += sin(t * 2) * 0.012 * motion
        }
        let stretch = clamp(-hopV * 0.04, -0.08, 0.1)
        return Frame(
            t: t, mood: mood,
            blink: blinkPhase < 0 ? 0 : sin(Double.pi * blinkPhase),
            gazeX: clamp(gazeX, -1, 1), gazeY: clamp(gazeY, -1, 1),
            scaleX: 1 + (breathe * amp - stretch * 0.6) * motion,
            scaleY: 1 + (-breathe * amp + stretch) * motion,
            offsetY: offsetY, rotation: angle, particles: particles
        )
    }
}

public struct Pt: Equatable, Sendable { public let x, y: Double }
public struct Segment: Equatable, Sendable { public let c1, c2, end: Pt }
public struct Bezier: Equatable, Sendable { public let start: Pt; public let segments: [Segment] }

/// Closed Catmull-Rom spline through the anchors as cubic Bezier segments; same math as `smoothOutline` in TS.
public func smoothOutline(_ points: [[Double]], tension: Double = 1) -> Bezier {
    let n = points.count
    let p = points.map { Pt(x: $0[0], y: $0[1]) }
    let segments = (0..<n).map { i -> Segment in
        let p0 = p[(i - 1 + n) % n], p1 = p[i], p2 = p[(i + 1) % n], p3 = p[(i + 2) % n]
        return Segment(
            c1: Pt(x: p1.x + (p2.x - p0.x) / 6 * tension, y: p1.y + (p2.y - p0.y) / 6 * tension),
            c2: Pt(x: p2.x - (p3.x - p1.x) / 6 * tension, y: p2.y - (p3.y - p1.y) / 6 * tension),
            end: p2
        )
    }
    return Bezier(start: p[0], segments: segments)
}

/// Arm direction in radians for an arm style; mirrors `armAngle` in TS.
public func armAngle(_ style: String, side: Int, t: Double) -> Double {
    let s = Double(side)
    switch style {
    case "wave": return side > 0 ? 2.4 + sin(t * 9) * 0.35 : 0.4
    case "up": return 2.5 + sin(t * 7 + s) * 0.2
    case "type": return 0.95 + sin(t * 16 + (side > 0 ? 0 : Double.pi)) * 0.15
    case "think": return side > 0 ? 2.1 : 0.35
    default: return 0.35 + sin(t * 2 + s) * 0.05
    }
}

private let searchTools: Set<String> = ["web_search", "search_files", "list_files", "read_file"]
public let sleepAfterMs: Int64 = 3 * 86_400_000
private let afterglowMs: Int64 = 6_000

/// Same mapping as `moodFor` in `packages/bot-face/src/status.ts`.
public func moodFor(status: String?, tool: String? = nil, finishedAt: Int64? = nil, lastActiveAt: Int64? = nil, now: Int64 = nowMillis()) -> String {
    switch status {
    case "queued": return "thinking"
    case "running":
        if tool == "ask_agent" { return "waiting" }
        if let tool { return searchTools.contains(tool) ? "searching" : "working" }
        return "thinking"
    case "waiting_approval": return "waiting"
    case "completed": if let finishedAt, now - finishedAt < afterglowMs { return "celebrate" }
    case "failed": if let finishedAt, now - finishedAt < afterglowMs { return "error" }
    default: break
    }
    if let lastActiveAt, now - lastActiveAt > sleepAfterMs { return "sleeping" }
    return "idle"
}

/// "7 天" style label shown under a sleeping bot.
public func sleepLabel(_ lastActiveAt: Int64, now: Int64 = nowMillis()) -> String? {
    let days = (now - lastActiveAt) / 86_400_000
    return days >= 1 ? "\(days) 天" : nil
}

public func nowMillis() -> Int64 { Int64((Date().timeIntervalSince1970 * 1000).rounded()) }
