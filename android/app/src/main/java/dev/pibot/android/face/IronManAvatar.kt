package dev.pibot.android.face

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.Dp
import dev.pibot.android.ui.ARMOR_MODELS
import dev.pibot.android.ui.ArmorVariant
import dev.pibot.android.ui.armorFor

@Composable
fun IronManAvatar(
    seed: String,
    mood: String = "idle",
    size: Dp,
    modifier: Modifier = Modifier,
    armorIndex: Int? = null,
) {
    val armor = remember(seed, armorIndex) {
        if (armorIndex != null && armorIndex in ARMOR_MODELS.indices) ARMOR_MODELS[armorIndex]
        else armorFor(seed)
    }

    Canvas(modifier.size(size)) {
        val w = this.size.width
        val h = this.size.height
        fun x(v: Float) = w * (v / 100f)
        fun y(v: Float) = h * (v / 100f)
        val u = minOf(w, h) / 100f

        val isWide = armor.variant == ArmorVariant.MK44 || armor.variant == ArmorVariant.MK17
        val isNano = armor.variant == ArmorVariant.MK50 || armor.variant == ArmorVariant.MK85
        val isStriped = armor.variant == ArmorVariant.MK5
        val isSharp = armor.variant == ArmorVariant.MK6 || armor.variant == ArmorVariant.MK33
        val isTactical = armor.variant == ArmorVariant.WM4 || armor.variant == ArmorVariant.MK7
        val isSpace = armor.variant == ArmorVariant.MK39
        val isSplit = armor.variant == ArmorVariant.MK42

        val eyeColor = when (mood) {
            "error" -> Color(0xFFFF5B5B)
            "waiting" -> Color(0xFFFFC154)
            else -> armor.eyeColor
        }
        val eyeGlow = when (mood) {
            "error" -> Color(0xFFFF2B2B)
            "waiting" -> Color(0xFFFF9F1C)
            else -> armor.eyeGlow
        }
        val eyeAlpha = when (mood) {
            "sleeping" -> 0.35f
            "working", "thinking", "error", "waiting" -> 1.0f
            else -> 0.9f
        }
        val eyeScaleY = if (mood == "sleeping") 0.55f else 1.0f

        // 背景圆 + 外金属圈
        drawCircle(
            brush = Brush.radialGradient(
                colors = listOf(Color(0xFF1B2638), Color(0xFF0F1521), Color(0xFF080B12)),
                center = Offset(x(35f), y(25f)),
                radius = 75f * u,
            ),
            radius = 47f * u,
            center = Offset(x(50f), y(50f)),
        )
        drawCircle(
            color = armor.faceplate.copy(alpha = 0.5f),
            radius = 47f * u,
            center = Offset(x(50f), y(50f)),
            style = Stroke(width = 1.8f * u),
        )
        drawCircle(
            color = eyeGlow.copy(alpha = 0.28f),
            radius = 43.5f * u,
            center = Offset(x(50f), y(50f)),
            style = Stroke(
                width = 0.9f * u,
                pathEffect = PathEffect.dashPathEffect(if (isTactical) floatArrayOf(6f * u, 3f * u) else floatArrayOf(14f * u, 6f * u)),
            ),
        )

        val shellBrush = Brush.linearGradient(
            colors = listOf(armor.primaryBright, armor.primary, armor.primaryDark),
            start = Offset(x(15f), y(6f)),
            end = Offset(x(85f), y(94f)),
        )
        val faceBrush = Brush.linearGradient(
            colors = listOf(armor.faceplateBright, armor.faceplate, armor.faceplateDark),
            start = Offset(x(18f), y(10f)),
            end = Offset(x(82f), y(90f)),
        )
        val specBrush = Brush.linearGradient(
            colors = listOf(Color.White.copy(alpha = 0.42f), Color.White.copy(alpha = 0.05f), Color.Black.copy(alpha = 0.2f)),
            start = Offset(x(20f), y(10f)),
            end = Offset(x(80f), y(80f)),
        )

        // 重装护耳块
        if (isWide || isTactical) {
            val leftEar = Path().apply {
                moveTo(x(12f), y(42f)); lineTo(x(20f), y(35f)); lineTo(x(20f), y(63f)); lineTo(x(12f), y(58f)); close()
            }
            val rightEar = Path().apply {
                moveTo(x(88f), y(42f)); lineTo(x(80f), y(35f)); lineTo(x(80f), y(63f)); lineTo(x(88f), y(58f)); close()
            }
            drawPath(leftEar, shellBrush)
            drawPath(leftEar, armor.trim, style = Stroke(1.2f * u))
            drawPath(rightEar, shellBrush)
            drawPath(rightEar, armor.trim, style = Stroke(1.2f * u))
        }

        // 外壳头盔轮廓
        val helmet = Path().apply {
            if (isSharp) {
                moveTo(x(50f), y(10f))
                lineTo(x(75f), y(21f))
                lineTo(x(82f), y(46f))
                lineTo(x(76f), y(72f))
                lineTo(x(62f), y(88f))
                lineTo(x(50f), y(91f))
                lineTo(x(38f), y(88f))
                lineTo(x(24f), y(72f))
                lineTo(x(18f), y(46f))
                lineTo(x(25f), y(21f))
                close()
            } else {
                val side = if (isWide) 85f else 81f
                val left = 100f - side
                val jaw = if (isWide) 81f else 77f
                val jawL = 100f - jaw
                moveTo(x(50f), y(10.5f))
                cubicTo(x(69f), y(10.5f), x(side - 1f), y(23f), x(side), y(44f))
                lineTo(x(jaw), y(71f))
                cubicTo(x(jaw - 4f), y(83f), x(63f), y(89f), x(50f), y(90f))
                cubicTo(x(37f), y(89f), x(jawL + 4f), y(83f), x(jawL), y(71f))
                lineTo(x(left), y(44f))
                cubicTo(x(left + 1f), y(23f), x(31f), y(10.5f), x(50f), y(10.5f))
                close()
            }
        }
        drawPath(helmet, shellBrush)
        drawPath(helmet, armor.trim, style = Stroke(1.8f * u, join = StrokeJoin.Round))

        // 顶部高光与额冠
        val crown = Path().apply {
            moveTo(x(36f), y(14f)); lineTo(x(50f), y(11f)); lineTo(x(64f), y(14f)); lineTo(x(59f), y(29f)); lineTo(x(41f), y(29f)); close()
        }
        drawPath(crown, specBrush)
        if (isSpace) {
            val visorBand = Path().apply {
                moveTo(x(31f), y(20f)); lineTo(x(69f), y(20f)); lineTo(x(65f), y(28f)); lineTo(x(35f), y(28f)); close()
            }
            drawPath(visorBand, armor.trim.copy(alpha = 0.65f))
        }

        // 面甲主体
        val face = Path().apply {
            val topOuter = if (isWide) 32f else if (isNano) 35f else 34f
            val midOuter = if (isWide) 76f else 74f
            moveTo(x(topOuter), y(27f))
            lineTo(x(43f), y(32f))
            lineTo(x(57f), y(32f))
            lineTo(x(100f - topOuter), y(27f))
            lineTo(x(midOuter), y(45f))
            lineTo(x(69f), y(68f))
            lineTo(x(60f), y(80f))
            lineTo(x(56f), y(75f))
            lineTo(x(44f), y(75f))
            lineTo(x(40f), y(80f))
            lineTo(x(31f), y(68f))
            lineTo(x(100f - midOuter), y(45f))
            close()
        }
        drawPath(face, faceBrush)
        drawPath(face, armor.trim, style = Stroke(1.5f * u, join = StrokeJoin.Round))

        // 额头中央嵌块
        val forehead = Path().apply {
            moveTo(x(42f), y(21f)); lineTo(x(58f), y(21f)); lineTo(x(55f), y(34f)); lineTo(x(45f), y(34f)); close()
        }
        drawPath(forehead, shellBrush)
        drawPath(forehead, armor.trim, style = Stroke(1.2f * u))

        // 鼻梁高光 + 颧骨线
        val nose = Path().apply {
            moveTo(x(45f), y(34f)); lineTo(x(55f), y(34f)); lineTo(x(53f), y(64f)); lineTo(x(47f), y(64f)); close()
        }
        drawPath(nose, specBrush)
        val cheekL = Path().apply { moveTo(x(27f), y(49f)); lineTo(x(39f), y(58f)); lineTo(x(39f), y(74f)) }
        val cheekR = Path().apply { moveTo(x(73f), y(49f)); lineTo(x(61f), y(58f)); lineTo(x(61f), y(74f)) }
        drawPath(cheekL, armor.trim.copy(alpha = 0.65f), style = Stroke(1.2f * u))
        drawPath(cheekR, armor.trim.copy(alpha = 0.65f), style = Stroke(1.2f * u))

        // 型号专属细节
        if (isStriped) {
            val c = armor.primary.copy(alpha = 0.75f)
            drawLine(c, Offset(x(29f), y(38f)), Offset(x(39f), y(41f)), 1.5f * u)
            drawLine(c, Offset(x(71f), y(38f)), Offset(x(61f), y(41f)), 1.5f * u)
            drawLine(c, Offset(x(30f), y(60f)), Offset(x(39f), y(63f)), 1.5f * u)
            drawLine(c, Offset(x(70f), y(60f)), Offset(x(61f), y(63f)), 1.5f * u)
        }
        if (isSplit) {
            drawLine(armor.faceplateBright.copy(alpha = 0.65f), Offset(x(50f), y(34f)), Offset(x(50f), y(65f)), 1.1f * u)
        }
        if (isNano) {
            val c = eyeGlow.copy(alpha = 0.72f)
            drawLine(c, Offset(x(37f), y(30f)), Offset(x(42f), y(36f)), 1.1f * u)
            drawLine(c, Offset(x(63f), y(30f)), Offset(x(58f), y(36f)), 1.1f * u)
            drawLine(c, Offset(x(46f), y(66f)), Offset(x(54f), y(66f)), 1.1f * u)
        }
        if (isTactical) {
            drawRoundRect(
                color = eyeColor.copy(alpha = 0.65f),
                topLeft = Offset(x(44f), y(24f)),
                size = Size(12f * u, 3f * u),
                cornerRadius = CornerRadius(1f * u, 1f * u),
            )
        }

        // 下颌与口缝
        val chin = Path().apply {
            moveTo(x(39f), y(71f)); lineTo(x(45f), y(73f)); lineTo(x(55f), y(73f)); lineTo(x(61f), y(71f))
            lineTo(x(58f), y(84f)); lineTo(x(42f), y(84f)); close()
        }
        drawPath(chin, shellBrush)
        drawPath(chin, armor.trim, style = Stroke(1.2f * u))
        val mouth = Path().apply { moveTo(x(41f), y(75f)); lineTo(x(46f), y(77f)); lineTo(x(54f), y(77f)); lineTo(x(59f), y(75f)) }
        drawPath(mouth, armor.trim, style = Stroke(1.6f * u, cap = StrokeCap.Round))

        // 眼部辉光
        drawCircle(
            brush = Brush.radialGradient(
                colors = listOf(eyeGlow.copy(alpha = 0.65f * eyeAlpha), Color.Transparent),
                center = Offset(x(37.5f), y(48.8f)),
                radius = 11f * u,
            ),
            radius = 11f * u,
            center = Offset(x(37.5f), y(48.8f)),
        )
        drawCircle(
            brush = Brush.radialGradient(
                colors = listOf(eyeGlow.copy(alpha = 0.65f * eyeAlpha), Color.Transparent),
                center = Offset(x(62.5f), y(48.8f)),
                radius = 11f * u,
            ),
            radius = 11f * u,
            center = Offset(x(62.5f), y(48.8f)),
        )

        // 眼窝暗槽
        val socketL = Path().apply { moveTo(x(29.5f), y(45.5f)); lineTo(x(45f), y(48.2f)); lineTo(x(43f), y(52.2f)); lineTo(x(31.2f), y(50.8f)); close() }
        val socketR = Path().apply { moveTo(x(70.5f), y(45.5f)); lineTo(x(55f), y(48.2f)); lineTo(x(57f), y(52.2f)); lineTo(x(68.8f), y(50.8f)); close() }
        drawPath(socketL, Color(0xFF090D14))
        drawPath(socketR, Color(0xFF090D14))

        // 发光护目镜片
        val halfH = 1.6f * eyeScaleY
        val eyeL = Path().apply {
            moveTo(x(31.2f), y(48.2f - halfH))
            lineTo(x(44.2f), y(49.6f - halfH * 0.7f))
            lineTo(x(42.8f), y(49.8f + halfH))
            lineTo(x(32.2f), y(48.6f + halfH))
            close()
        }
        val eyeR = Path().apply {
            moveTo(x(68.8f), y(48.2f - halfH))
            lineTo(x(55.8f), y(49.6f - halfH * 0.7f))
            lineTo(x(57.2f), y(49.8f + halfH))
            lineTo(x(67.8f), y(48.6f + halfH))
            close()
        }
        drawPath(eyeL, eyeColor.copy(alpha = eyeAlpha))
        drawPath(eyeR, eyeColor.copy(alpha = eyeAlpha))
        drawLine(Color.White.copy(alpha = 0.85f * eyeAlpha), Offset(x(33f), y(48.2f)), Offset(x(42.5f), y(49.5f)), 1.0f * u, StrokeCap.Round)
        drawLine(Color.White.copy(alpha = 0.85f * eyeAlpha), Offset(x(67f), y(48.2f)), Offset(x(57.5f), y(49.5f)), 1.0f * u, StrokeCap.Round)
    }
}
