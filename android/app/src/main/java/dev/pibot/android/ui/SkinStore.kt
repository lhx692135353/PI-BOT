package dev.pibot.android.ui

import android.content.Context
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.ui.graphics.Color
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

enum class AppSkin(val wire: String, val label: String) {
    DEFAULT("default", "默认皮肤"),
    IRONMAN("ironman", "钢铁侠");

    companion object {
        fun fromWire(value: String?): AppSkin =
            if (value == IRONMAN.wire) IRONMAN else DEFAULT
    }
}

enum class ArmorVariant {
    MK3, MK5, MK6, MK7, MK17, MK33, MK39, MK42, MK44, MK50, MK85, WM4
}

data class ArmorSpec(
    val id: Int,
    val code: String,
    val name: String,
    val variant: ArmorVariant,
    val primary: Color,
    val primaryDark: Color,
    val primaryBright: Color,
    val faceplate: Color,
    val faceplateDark: Color,
    val faceplateBright: Color,
    val eyeColor: Color,
    val eyeGlow: Color,
    val trim: Color,
)

/**
 * 与 Desktop / iOS 完全一致的 12 款钢铁侠机甲有序列表。
 */
val ARMOR_MODELS: List<ArmorSpec> = listOf(
    ArmorSpec(0, "MK-III", "Mark III", ArmorVariant.MK3, Color(0xFFA7262D), Color(0xFF5B1015), Color(0xFFD6454D), Color(0xFFD8B467), Color(0xFF8C6927), Color(0xFFF6DF9D), Color(0xFF8BE9FF), Color(0xFF43C9FF), Color(0xFF221417)),
    ArmorSpec(1, "MK-V", "Mark V", ArmorVariant.MK5, Color(0xFFB42B33), Color(0xFF631218), Color(0xFFE04E56), Color(0xFFC9D2DC), Color(0xFF758291), Color(0xFFF1F5F9), Color(0xFF8BE9FF), Color(0xFF4BC6FF), Color(0xFF252B34)),
    ArmorSpec(2, "MK-VI", "Mark VI", ArmorVariant.MK6, Color(0xFF9E1F27), Color(0xFF530C11), Color(0xFFCF3C46), Color(0xFFDCBA6F), Color(0xFF8B6826), Color(0xFFF7E4A8), Color(0xFF76ECFF), Color(0xFF2FD8FF), Color(0xFF1D1114)),
    ArmorSpec(3, "MK-VII", "Mark VII", ArmorVariant.MK7, Color(0xFF982028), Color(0xFF4F0D12), Color(0xFFC93A43), Color(0xFFD2AE61), Color(0xFF7E5D20), Color(0xFFF1D893), Color(0xFF96EEFF), Color(0xFF48D3FF), Color(0xFF2A2224)),
    ArmorSpec(4, "MK-XVII", "Heartbreaker", ArmorVariant.MK17, Color(0xFF7F1A22), Color(0xFF3F090E), Color(0xFFB3303A), Color(0xFFC49D52), Color(0xFF73531B), Color(0xFFE8C982), Color(0xFF78E6FF), Color(0xFF32C8FF), Color(0xFF1B1417)),
    ArmorSpec(5, "MK-XXXIII", "Silver Centurion", ArmorVariant.MK33, Color(0xFF941D26), Color(0xFF4C0B10), Color(0xFFC73540), Color(0xFFD4DCE4), Color(0xFF7C8998), Color(0xFFF4F8FB), Color(0xFF84EBFF), Color(0xFF3BCAFF), Color(0xFF232830)),
    ArmorSpec(6, "MK-XXXIX", "Starboost", ArmorVariant.MK39, Color(0xFFD8DEE6), Color(0xFF808B99), Color(0xFFF6F9FC), Color(0xFFC6A55C), Color(0xFF775B21), Color(0xFFEAD08D), Color(0xFF7DEAFF), Color(0xFF35CCFF), Color(0xFF273140)),
    ArmorSpec(7, "MK-XLII", "Mark XLII", ArmorVariant.MK42, Color(0xFFD4B36A), Color(0xFF856628), Color(0xFFF3DC9D), Color(0xFF9D242B), Color(0xFF520E12), Color(0xFFCD4048), Color(0xFF90EEFF), Color(0xFF46D0FF), Color(0xFF2B1D17)),
    ArmorSpec(8, "MK-XLIV", "Hulkbuster", ArmorVariant.MK44, Color(0xFF8E1C23), Color(0xFF480A0F), Color(0xFFC2363E), Color(0xFFCFA95C), Color(0xFF7E5C1F), Color(0xFFEED18A), Color(0xFF98F2FF), Color(0xFF48D6FF), Color(0xFF2C1C1B)),
    ArmorSpec(9, "MK-L", "Mark L Nano", ArmorVariant.MK50, Color(0xFFB3212A), Color(0xFF5D0C12), Color(0xFFE3414C), Color(0xFFDFC074), Color(0xFF8E6D29), Color(0xFFFAEAAD), Color(0xFF7BF3FF), Color(0xFF27DFFF), Color(0xFF1D151D)),
    ArmorSpec(10, "MK-LXXXV", "Mark LXXXV", ArmorVariant.MK85, Color(0xFF8D1922), Color(0xFF46080D), Color(0xFFBF313B), Color(0xFFD6B15F), Color(0xFF825F1E), Color(0xFFF4D98D), Color(0xFF86ECFF), Color(0xFF38CFFF), Color(0xFF1E1316)),
    ArmorSpec(11, "WM-MK4", "War Machine", ArmorVariant.WM4, Color(0xFF3F4752), Color(0xFF1C2128), Color(0xFF6B7787), Color(0xFF7A8492), Color(0xFF434B56), Color(0xFFA9B3C1), Color(0xFFFF525C), Color(0xFFE52432), Color(0xFF13171D)),
)

/**
 * 确定性 FNV-1a 32-bit 哈希（UTF-8 字节），与 Desktop / iOS 完全一致。
 */
fun fnv1a32(input: String): Long {
    var hash = 0x811c9dc5L
    for (b in input.toByteArray(Charsets.UTF_8)) {
        hash = hash xor (b.toLong() and 0xffL)
        hash = (hash * 0x01000193L) and 0xffffffffL
    }
    return hash
}

fun armorIndexFor(seed: String): Int = (fnv1a32(seed) % ARMOR_MODELS.size).toInt()

fun armorFor(seed: String): ArmorSpec = ARMOR_MODELS[armorIndexFor(seed)]

class SkinStore(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    private val _skin = MutableStateFlow(AppSkin.fromWire(prefs.getString(KEY_SKIN, AppSkin.DEFAULT.wire)))
    val skin: StateFlow<AppSkin> = _skin.asStateFlow()

    fun setLocal(skin: AppSkin) {
        if (_skin.value != skin) {
            _skin.value = skin
        }
        prefs.edit().putString(KEY_SKIN, skin.wire).apply()
    }

    fun applyFromServer(wire: String?) {
        setLocal(AppSkin.fromWire(wire))
    }

    companion object {
        private const val PREFS_NAME = "pibot_skin_prefs"
        private const val KEY_SKIN = "skin"
    }
}

val LocalAppSkin = compositionLocalOf { AppSkin.DEFAULT }
