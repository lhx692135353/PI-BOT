package dev.pibot.android.ui

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

data class PiBotPalette(
    val accent: Color,
    val accentSoft: Color,
    val paper: Color,
    val card: Color,
    val ink: Color,
    val muted: Color,
    val line: Color,
    val good: Color,
    val danger: Color,
)

private val DefaultPalette = PiBotPalette(
    accent = Color(0xFFF4692A),
    accentSoft = Color(0xFFFFEFE4),
    paper = Color(0xFFF6F4F1),
    card = Color(0xFFFFFFFF),
    ink = Color(0xFF1F1F23),
    muted = Color(0xFF8A877F),
    line = Color(0xFFE7E3DC),
    good = Color(0xFF2FA36B),
    danger = Color(0xFFD9483B),
)

private val IronManPalette = PiBotPalette(
    accent = Color(0xFFB52B33),
    accentSoft = Color(0xFF2A161B),
    paper = Color(0xFF0B0F17),
    card = Color(0xFF131A26),
    ink = Color(0xFFEEF2F7),
    muted = Color(0xFF93A1B5),
    line = Color(0xFF232E42),
    good = Color(0xFF75DDF1),
    danger = Color(0xFFFF7A7F),
)

val LocalPiBotPalette = staticCompositionLocalOf { DefaultPalette }

val Accent: Color @Composable get() = LocalPiBotPalette.current.accent
val AccentSoft: Color @Composable get() = LocalPiBotPalette.current.accentSoft
val Paper: Color @Composable get() = LocalPiBotPalette.current.paper
val Card: Color @Composable get() = LocalPiBotPalette.current.card
val Ink: Color @Composable get() = LocalPiBotPalette.current.ink
val Muted: Color @Composable get() = LocalPiBotPalette.current.muted
val Line: Color @Composable get() = LocalPiBotPalette.current.line
val Good: Color @Composable get() = LocalPiBotPalette.current.good
val Danger: Color @Composable get() = LocalPiBotPalette.current.danger

private val defaultColors = lightColorScheme(
    primary = DefaultPalette.accent,
    onPrimary = Color.White,
    primaryContainer = DefaultPalette.accentSoft,
    onPrimaryContainer = Color(0xFF7A2E0B),
    secondary = DefaultPalette.ink,
    onSecondary = Color.White,
    background = DefaultPalette.paper,
    onBackground = DefaultPalette.ink,
    surface = DefaultPalette.paper,
    onSurface = DefaultPalette.ink,
    surfaceVariant = Color(0xFFEFEBE5),
    onSurfaceVariant = DefaultPalette.muted,
    surfaceContainer = DefaultPalette.card,
    surfaceContainerLow = DefaultPalette.card,
    surfaceContainerHigh = DefaultPalette.card,
    surfaceContainerHighest = Color(0xFFEFEBE5),
    outline = DefaultPalette.line,
    outlineVariant = DefaultPalette.line,
    error = DefaultPalette.danger,
)

private val ironManColors = darkColorScheme(
    primary = IronManPalette.accent,
    onPrimary = Color(0xFFFFF8EB),
    primaryContainer = IronManPalette.accentSoft,
    onPrimaryContainer = Color(0xFFF3DC9D),
    secondary = Color(0xFFD6B26A),
    onSecondary = Color(0xFF1A1208),
    tertiary = Color(0xFF75DDF1),
    onTertiary = Color(0xFF06202A),
    background = IronManPalette.paper,
    onBackground = IronManPalette.ink,
    surface = IronManPalette.paper,
    onSurface = IronManPalette.ink,
    surfaceVariant = Color(0xFF192233),
    onSurfaceVariant = IronManPalette.muted,
    surfaceContainer = IronManPalette.card,
    surfaceContainerLow = Color(0xFF101723),
    surfaceContainerHigh = Color(0xFF192233),
    surfaceContainerHighest = Color(0xFF202B3F),
    outline = IronManPalette.line,
    outlineVariant = IronManPalette.line,
    error = IronManPalette.danger,
)

@Composable
fun PiBotTheme(skin: AppSkin = AppSkin.DEFAULT, content: @Composable () -> Unit) {
    val palette = if (skin == AppSkin.IRONMAN) IronManPalette else DefaultPalette
    val colors = if (skin == AppSkin.IRONMAN) ironManColors else defaultColors
    CompositionLocalProvider(
        LocalAppSkin provides skin,
        LocalPiBotPalette provides palette,
    ) {
        MaterialTheme(
            colorScheme = colors,
            shapes = Shapes(small = RoundedCornerShape(10.dp), medium = RoundedCornerShape(16.dp), large = RoundedCornerShape(22.dp)),
            content = content,
        )
    }
}
