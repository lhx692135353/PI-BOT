package dev.pibot.android.ui

import android.provider.Settings
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.pow
import kotlin.math.sin

private fun easeOutCubic(x: Float): Float = 1f - (1f - x).pow(3)
private fun easeInOutQuart(x: Float): Float =
    if (x < 0.5f) 8f * x * x * x * x else 1f - (-2f * x + 2f).pow(4) / 2f

/**
 * 竖屏原生 Compose 钢铁侠面甲机械入场动画：
 * 1. 双目护目镜点亮 + 中央方舟反应堆涡轮加速咬合；
 * 2. 额甲上掀、下颌下滑、两侧液压导轨外扩；
 * 3. 平滑淡出进入主界面，支持点击跳过并遵循系统减弱动画设置。
 */
@Composable
fun IronManIntroOverlay(onDone: () -> Unit) {
    val context = LocalContext.current
    val reduceMotion = remember {
        runCatching {
            Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
        }.getOrDefault(false)
    }

    val progress = remember { Animatable(0f) }

    LaunchedEffect(reduceMotion) {
        if (reduceMotion) {
            onDone()
            return@LaunchedEffect
        }
        progress.animateTo(1f, animationSpec = tween(durationMillis = 2250, easing = LinearEasing))
        onDone()
    }

    if (reduceMotion) return

    val t = progress.value
    val fade = if (t > 0.78f) 1f - ((t - 0.78f) / 0.22f).coerceIn(0f, 1f) else 1f

    Box(
        Modifier
            .fillMaxSize()
            .graphicsLayer { alpha = fade }
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
                onClick = onDone,
            ),
    ) {
        Canvas(Modifier.fillMaxSize()) {
            val w = size.width
            val h = size.height
            val cx = w * 0.5f
            val cy = h * 0.46f

            // 背景暗幕
            drawRect(
                brush = Brush.radialGradient(
                    colors = listOf(Color(0xFF131D2E), Color(0xFF070A10), Color(0xFF030508)),
                    center = Offset(cx, cy),
                    radius = maxOf(w, h) * 0.75f,
                ),
            )

            val ignite = easeOutCubic((t / 0.34f).coerceIn(0f, 1f))
            val openRaw = ((t - 0.34f) / 0.52f).coerceIn(0f, 1f)
            val open = easeInOutQuart(openRaw)

            val upperShift = -open * h * 0.62f
            val lowerShift = open * h * 0.62f
            val railShift = open * w * 0.34f

            val crimsonBrush = Brush.verticalGradient(listOf(Color(0xFFC2323A), Color(0xFF8C1921), Color(0xFF4F0B10)))
            val goldBrush = Brush.linearGradient(
                colors = listOf(Color(0xFFF6DF9D), Color(0xFFD6B26A), Color(0xFF8C6927)),
                start = Offset(w * 0.15f, h * 0.1f),
                end = Offset(w * 0.85f, h * 0.9f),
            )
            val titaniumBrush = Brush.verticalGradient(listOf(Color(0xFF222D40), Color(0xFF101622)))

            // 两侧竖向液压导轨
            drawRect(
                brush = titaniumBrush,
                topLeft = Offset(-railShift, 0f),
                size = Size(w * 0.12f, h),
            )
            drawRect(
                brush = titaniumBrush,
                topLeft = Offset(w * 0.88f + railShift, 0f),
                size = Size(w * 0.12f, h),
            )
            drawLine(
                color = Color(0xFFD6B26A).copy(alpha = 0.55f),
                start = Offset(w * 0.12f - railShift, 0f),
                end = Offset(w * 0.12f - railShift, h),
                strokeWidth = 3f,
            )
            drawLine(
                color = Color(0xFFD6B26A).copy(alpha = 0.55f),
                start = Offset(w * 0.88f + railShift, 0f),
                end = Offset(w * 0.88f + railShift, h),
                strokeWidth = 3f,
            )

            // 上半额甲（向上液压掀开）
            val upperPath = Path().apply {
                moveTo(0f, upperShift)
                lineTo(w, upperShift)
                lineTo(w, cy + upperShift - h * 0.02f)
                lineTo(w * 0.72f, cy + upperShift + h * 0.04f)
                lineTo(w * 0.28f, cy + upperShift + h * 0.04f)
                lineTo(0f, cy + upperShift - h * 0.02f)
                close()
            }
            drawPath(upperPath, crimsonBrush)

            // 上面甲金色中央面板
            val upperGold = Path().apply {
                moveTo(w * 0.16f, upperShift + h * 0.06f)
                lineTo(w * 0.84f, upperShift + h * 0.06f)
                lineTo(w * 0.74f, cy + upperShift + h * 0.025f)
                lineTo(w * 0.26f, cy + upperShift + h * 0.025f)
                close()
            }
            drawPath(upperGold, goldBrush)
            drawPath(upperGold, Color(0xFF1F1215), style = Stroke(width = 4f))

            // 发光双目护目镜（随额甲上掀）
            val eyeY = cy + upperShift - h * 0.085f
            val eyeW = w * 0.22f
            val eyeH = h * 0.026f
            val leftEyeCenter = Offset(cx - w * 0.18f, eyeY)
            val rightEyeCenter = Offset(cx + w * 0.18f, eyeY)
            val eyeGlowRadius = w * 0.2f

            drawCircle(
                brush = Brush.radialGradient(
                    colors = listOf(Color(0xFF4AD5FF).copy(alpha = 0.65f * ignite), Color.Transparent),
                    center = leftEyeCenter,
                    radius = eyeGlowRadius,
                ),
                radius = eyeGlowRadius,
                center = leftEyeCenter,
            )
            drawCircle(
                brush = Brush.radialGradient(
                    colors = listOf(Color(0xFF4AD5FF).copy(alpha = 0.65f * ignite), Color.Transparent),
                    center = rightEyeCenter,
                    radius = eyeGlowRadius,
                ),
                radius = eyeGlowRadius,
                center = rightEyeCenter,
            )

            val eyeL = Path().apply {
                moveTo(cx - w * 0.30f, eyeY - eyeH * 0.8f)
                lineTo(cx - w * 0.08f, eyeY - eyeH * 0.1f)
                lineTo(cx - w * 0.10f, eyeY + eyeH * 0.9f)
                lineTo(cx - w * 0.28f, eyeY + eyeH * 0.5f)
                close()
            }
            val eyeR = Path().apply {
                moveTo(cx + w * 0.30f, eyeY - eyeH * 0.8f)
                lineTo(cx + w * 0.08f, eyeY - eyeH * 0.1f)
                lineTo(cx + w * 0.10f, eyeY + eyeH * 0.9f)
                lineTo(cx + w * 0.28f, eyeY + eyeH * 0.5f)
                close()
            }
            drawPath(eyeL, Color(0xFF8BEFFF).copy(alpha = 0.2f + 0.8f * ignite))
            drawPath(eyeR, Color(0xFF8BEFFF).copy(alpha = 0.2f + 0.8f * ignite))

            // 下半下颌甲（向下液压滑落）
            val lowerPath = Path().apply {
                moveTo(0f, cy + lowerShift - h * 0.01f)
                lineTo(w * 0.28f, cy + lowerShift + h * 0.05f)
                lineTo(w * 0.72f, cy + lowerShift + h * 0.05f)
                lineTo(w, cy + lowerShift - h * 0.01f)
                lineTo(w, h + lowerShift)
                lineTo(0f, h + lowerShift)
                close()
            }
            drawPath(lowerPath, crimsonBrush)
            val jawGold = Path().apply {
                moveTo(w * 0.26f, cy + lowerShift + h * 0.06f)
                lineTo(w * 0.74f, cy + lowerShift + h * 0.06f)
                lineTo(w * 0.64f, cy + lowerShift + h * 0.22f)
                lineTo(w * 0.36f, cy + lowerShift + h * 0.22f)
                close()
            }
            drawPath(jawGold, goldBrush)
            drawPath(jawGold, Color(0xFF1F1215), style = Stroke(width = 4f))

            // 中央反应堆与旋转机械涡轮环
            val reactorAlpha = (1f - ((t - 0.52f) / 0.34f).coerceIn(0f, 1f))
            if (reactorAlpha > 0.01f) {
                val r = minOf(w, h) * 0.14f * (1f + open * 0.45f)
                drawCircle(
                    brush = Brush.radialGradient(
                        colors = listOf(Color(0xFF7AF0FF).copy(alpha = 0.8f * ignite * reactorAlpha), Color.Transparent),
                        center = Offset(cx, cy),
                        radius = r * 2.1f,
                    ),
                    radius = r * 2.1f,
                    center = Offset(cx, cy),
                )
                drawCircle(
                    color = Color(0xFF1E2A3D).copy(alpha = reactorAlpha),
                    radius = r * 1.12f,
                    center = Offset(cx, cy),
                    style = Stroke(width = r * 0.16f),
                )
                rotate(degrees = t * 420f, pivot = Offset(cx, cy)) {
                    for (i in 0 until 12) {
                        val a = (i * 30.0) * PI / 180.0
                        val sx = cx + cos(a).toFloat() * r * 0.76f
                        val sy = cy + sin(a).toFloat() * r * 0.76f
                        val ex = cx + cos(a).toFloat() * r * 1.02f
                        val ey = cy + sin(a).toFloat() * r * 1.02f
                        drawLine(
                            color = Color(0xFFD6B26A).copy(alpha = 0.9f * reactorAlpha),
                            start = Offset(sx, sy),
                            end = Offset(ex, ey),
                            strokeWidth = r * 0.11f,
                            cap = StrokeCap.Round,
                        )
                    }
                }
                drawCircle(
                    color = Color(0xFF7AEBFF).copy(alpha = (0.3f + 0.7f * ignite) * reactorAlpha),
                    radius = r * 0.62f,
                    center = Offset(cx, cy),
                    style = Stroke(width = r * 0.11f),
                )
                drawCircle(
                    color = Color(0xFFE5FAFF).copy(alpha = ignite * reactorAlpha),
                    radius = r * 0.36f,
                    center = Offset(cx, cy),
                )
            }
        }

        Column(
            modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 52.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text("MARK-OS // STARK HUD", color = Color(0xFFD8B467), fontSize = 12.sp, fontWeight = FontWeight.Bold, letterSpacing = 2.sp)
            Text("ARMOR SYSTEMS ONLINE", color = Color(0xFF7AEAFF), fontSize = 11.sp, letterSpacing = 1.6.sp)
        }

        Surface(
            modifier = Modifier
                .align(Alignment.TopEnd)
                .statusBarsPadding()
                .padding(16.dp)
                .clickable(onClick = onDone),
            shape = RoundedCornerShape(999.dp),
            color = Color(0xCC101929),
        ) {
            Text("跳过", color = Color(0xFFD8E7F8), fontSize = 12.sp, modifier = Modifier.padding(horizontal = 14.dp, vertical = 6.dp))
        }
    }
}
