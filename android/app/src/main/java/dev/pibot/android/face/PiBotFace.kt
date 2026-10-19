package dev.pibot.android.face

import android.content.Context
import android.provider.Settings
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotateRad
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.Dp
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

/** Unit space: the body spans roughly -1..1 and is drawn at `size * SCALE`. */
private const val SCALE = 0.34f
private const val CENTER_Y = 0.56f
private const val LIGHT_INK = "#F5F5F7"

object BotFaceAssets {
    @Volatile
    private var cached: PiBotSpec? = null

    fun spec(context: Context): PiBotSpec = cached ?: synchronized(this) {
        cached ?: PiBotSpec.parse(context.assets.open("bot-face/spec.json").bufferedReader().use { it.readText() }).also { cached = it }
    }
}

fun parseColor(hex: String): Color = Color(android.graphics.Color.parseColor(hex))

/**
 * Animated Pi Bot character. [paused] renders a still frame (lists with many bots);
 * [seed] keeps confetti and blinking deterministic per bot.
 * [entrance] plays a single welcome hop and turn, respecting reduced motion.
 */
@Composable
fun PiBotFace(avatar: Avatar, mood: String, size: Dp, modifier: Modifier = Modifier, seed: Int = 1, paused: Boolean = false, effects: Boolean = true, entrance: Boolean = false) {
    val context = LocalContext.current
    val spec = remember { BotFaceAssets.spec(context) }
    val reduceMotion = remember { reduceMotion(context) }
    val engine = remember(seed) { PiBotEngine(spec, mood, seed, reduceMotion) }
    var frame by remember(engine) { mutableStateOf(engine.frame()) }
    engine.setMood(mood)
    LaunchedEffect(engine, entrance) {
        if (entrance && !paused) {
            engine.bounce()
            engine.spin()
        }
    }
    LaunchedEffect(engine, paused, mood) {
        if (paused || reduceMotion) {
            engine.step(0.0)
            frame = engine.frame()
            return@LaunchedEffect
        }
        var last = 0L
        while (true) {
            withFrameNanos { now ->
                if (last != 0L) engine.step((now - last) / 1e9)
                last = now
                frame = engine.frame()
            }
        }
    }
    val look = avatar.normalized()
    Canvas(modifier.size(size)) { drawBot(spec, frame, look, this.size.minDimension, effects) }
}

private fun reduceMotion(context: Context): Boolean =
    runCatching { Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f }.getOrDefault(false)

private fun DrawScope.oval(color: Color, cx: Double, cy: Double, rx: Double, ry: Double, alpha: Float = 1f) {
    drawOval(color, Offset((cx - rx).toFloat(), (cy - ry).toFloat()), Size((rx * 2).toFloat(), (ry * 2).toFloat()), alpha)
}

private fun DrawScope.circle(color: Color, cx: Double, cy: Double, r: Double, alpha: Float = 1f) {
    drawCircle(color, r.toFloat(), Offset(cx.toFloat(), cy.toFloat()), alpha)
}

private fun stroke(width: Double) = Stroke(width.toFloat(), cap = StrokeCap.Round, join = StrokeJoin.Round)

private fun Path.move(x: Double, y: Double) = moveTo(x.toFloat(), y.toFloat())
private fun Path.line(x: Double, y: Double) = lineTo(x.toFloat(), y.toFloat())
private fun Path.quad(cx: Double, cy: Double, x: Double, y: Double) = quadraticTo(cx.toFloat(), cy.toFloat(), x.toFloat(), y.toFloat())

/** Port of `drawBot` in `packages/bot-face/src/render.ts`. */
fun DrawScope.drawBot(spec: PiBotSpec, frame: Frame, avatar: Avatar, size: Float, effects: Boolean = true) {
    val shape = spec.shape(avatar.shape)
    val color = spec.color(avatar.color)
    val mood = spec.mood(frame.mood)
    val (top, bottom) = (if (avatar.scheme == "dark") color.dark else color.light).map(::parseColor)
    val ink = parseColor(color.ink)
    val lightInk = color.ink == LIGHT_INK
    val t = frame.t
    withTransform({
        translate(size / 2, size * CENTER_Y)
        scale(size * SCALE, size * SCALE, Offset.Zero)
    }) {
        val lift = min(0.5, abs(frame.offsetY) * 3)
        oval(Color.Black, 0.0, 0.98, 0.62 * (1 - lift), 0.075 * (1 - lift), alpha = 0.12f)

        withTransform({
            translate(0f, frame.offsetY.toFloat())
            rotateRad(frame.rotation.toFloat(), Offset.Zero)
            translate(0f, 0.8f)
            scale(frame.scaleX.toFloat(), frame.scaleY.toFloat(), Offset.Zero)
            translate(0f, -0.8f)
        }) {
            for (side in intArrayOf(-1, 1)) oval(bottom, side * 0.32, 0.84, 0.17, 0.1)
            if (mood.arms != "hidden") {
                for (side in intArrayOf(-1, 1)) {
                    val a = armAngle(mood.arms, side, t)
                    val sx = side * 0.68
                    val sy = 0.18
                    drawLine(
                        bottom,
                        Offset(sx.toFloat(), sy.toFloat()),
                        Offset((sx + side * sin(a) * 0.34).toFloat(), (sy + cos(a) * 0.34).toFloat()),
                        strokeWidth = 0.2f,
                        cap = StrokeCap.Round,
                    )
                }
            }

            val outline = smoothOutline(shape.points)
            val body = Path().apply {
                move(outline.start.x, outline.start.y)
                for (s in outline.segments) cubicTo(s.c1.x.toFloat(), s.c1.y.toFloat(), s.c2.x.toFloat(), s.c2.y.toFloat(), s.end.x.toFloat(), s.end.y.toFloat())
                close()
            }
            drawPath(body, Brush.verticalGradient(listOf(top, bottom), startY = -0.95f, endY = 0.9f))

            withTransform({ rotateRad(-0.55f, Offset(-0.34f, -0.46f)) }) {
                oval(Color.White, -0.34, -0.46, 0.22, 0.12, alpha = 0.26f)
            }

            val face = shape.face
            val cheek = parseColor(color.cheek)
            for (side in intArrayOf(-1, 1)) oval(cheek, side * (face.gap / 2 + 0.13), face.y + 0.17, 0.1, 0.06, alpha = 0.45f)

            val gx = frame.gazeX * 0.06
            val gy = frame.gazeY * 0.05
            for (side in intArrayOf(-1, 1)) {
                val style = if (mood.eyes == "wink") (if (side < 0) "open" else "happy") else mood.eyes
                drawEye(style, side * (face.gap / 2) + gx, face.y + gy, face.eye, frame.blink, ink, lightInk)
            }
            drawMouth(mood.mouth, gx * 0.5, face.y + 0.2 + gy * 0.5, ink)
        }

        if (effects) drawEffect(mood.effect, t, lightInk, bottom)
        for (p in frame.particles) {
            withTransform({
                translate(p.x.toFloat(), p.y.toFloat())
                rotateRad(p.rotation.toFloat(), Offset.Zero)
            }) {
                drawRect(parseColor(spec.confetti[p.color % spec.confetti.size]), Offset(-0.035f, -0.018f), Size(0.07f, 0.036f), alpha = min(1.0, p.life / 0.4).toFloat())
            }
        }
    }
}

private fun DrawScope.drawEye(style: String, x: Double, y: Double, e: Double, blink: Double, ink: Color, lightInk: Boolean) {
    val open = 1 - blink * 0.9
    when (style) {
        "happy" -> drawPath(Path().apply { move(x - e * 0.75, y + e * 0.25); quad(x, y - e * 0.9, x + e * 0.75, y + e * 0.25) }, ink, style = stroke(e * 0.38))
        "closed" -> drawPath(Path().apply { move(x - e * 0.8, y - e * 0.1); quad(x, y + e * 0.75, x + e * 0.8, y - e * 0.1) }, ink, style = stroke(e * 0.38))
        "small" -> oval(ink, x, y, e * 0.42, e * 0.48 * open)
        else -> {
            val ry = e * (if (style == "focus") 0.6 else 1.0) * open
            oval(ink, x, y, e * 0.72, max(ry, e * 0.08))
            if (blink < 0.5 && !lightInk) circle(Color.White, x + e * 0.22, y - ry * 0.38, e * 0.2, alpha = 0.9f)
        }
    }
}

private fun DrawScope.drawMouth(style: String, x: Double, y: Double, ink: Color) {
    when (style) {
        "open" -> {
            drawPath(Path().apply { move(x - 0.11, y - 0.02); quad(x, y + 0.17, x + 0.11, y - 0.02); close() }, ink)
            oval(Color(0xFFFF7A85), x, y + 0.055, 0.045, 0.022)
        }
        "flat" -> drawPath(Path().apply { move(x - 0.07, y + 0.02); line(x + 0.07, y + 0.02) }, ink, style = stroke(0.034))
        "o" -> oval(ink, x, y + 0.03, 0.045, 0.055)
        "frown" -> drawPath(Path().apply { move(x - 0.08, y + 0.05); quad(x, y - 0.03, x + 0.08, y + 0.05) }, ink, style = stroke(0.034))
        else -> drawPath(Path().apply { move(x - 0.09, y - 0.01); quad(x, y + 0.08, x + 0.09, y - 0.01) }, ink, style = stroke(0.034))
    }
}

private fun DrawScope.drawEffect(effect: String, t: Double, lightInk: Boolean, accent: Color) {
    when (effect) {
        "dots" -> for (i in 0 until 3) {
            val alpha = 0.25 + 0.75 * max(0.0, sin(t * 4 - i * 0.8))
            circle(Color(0xFF8A8F98), 0.6 + i * 0.15, -0.95 - i * 0.06, 0.045 + i * 0.012, alpha.toFloat())
        }
        "question" -> {
            val y = -1.0 + sin(t * 3) * 0.04
            val r = 0.11
            val path = Path().apply {
                arcTo(Rect((0.8 - r).toFloat(), (y - r).toFloat(), (0.8 + r).toFloat(), (y + r).toFloat()), 198f, 225f, true)
                line(0.8, y + 0.2)
            }
            drawPath(path, accent, style = stroke(0.07))
            circle(accent, 0.8, y + 0.32, 0.04)
        }
        "alert" -> {
            val y = -1.05 + sin(t * 6) * 0.025
            val red = Color(0xFFF04438)
            drawLine(red, Offset(0.8f, y.toFloat()), Offset(0.8f, (y + 0.24).toFloat()), strokeWidth = 0.08f, cap = StrokeCap.Round)
            circle(red, 0.8, y + 0.37, 0.045)
        }
        "zzz" -> {
            val c = if (lightInk) Color(0xFF9CA3AF) else Color(0xFF6B7280)
            for (i in 0 until 3) {
                val phase = (t * 0.45 + i / 3.0) % 1
                val s = 0.08 + phase * 0.08
                val x = 0.5 + phase * 0.38
                val y = -0.72 - phase * 0.5
                val z = Path().apply { move(x - s, y - s); line(x + s, y - s); line(x - s, y + s); line(x + s, y + s) }
                drawPath(z, c, alpha = sin(phase * PI).toFloat(), style = stroke(0.035))
            }
        }
        "sparkle" -> {
            val spots = arrayOf(-0.85 to -0.75, 0.88 to -0.6, 0.6 to -1.02)
            for (i in 0 until 3) {
                val s = 0.05 + 0.04 * max(0.0, sin(t * 5 + i * 2.1))
                val (x, y) = spots[i]
                val star = Path().apply {
                    move(x, y - s * 2)
                    quad(x, y, x + s * 2, y)
                    quad(x, y, x, y + s * 2)
                    quad(x, y, x - s * 2, y)
                    quad(x, y, x, y - s * 2)
                }
                drawPath(star, Color(0xFFFFD166))
            }
        }
    }
}

/** Stable per-bot seed for the animation engine. */
fun seedOf(id: String): Int = id.hashCode()
