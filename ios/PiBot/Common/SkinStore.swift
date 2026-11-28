import Foundation
import Observation
import SwiftUI
import UIKit
import PiBotKit

enum AppSkin: String, CaseIterable, Identifiable {
    case `default` = "default"
    case ironman = "ironman"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .default: return "默认皮肤"
        case .ironman: return "钢铁侠"
        }
    }

    var subtitle: String {
        switch self {
        case .default: return "经典暖纸界面 · 原生 Bot 头像"
        case .ironman: return "红金反应堆配色 · 12 款固定机甲头像"
        }
    }

    static func fromWire(_ wire: String?) -> AppSkin {
        wire == AppSkin.ironman.rawValue ? .ironman : .default
    }
}

enum ArmorVariant: String {
    case mk3, mk5, mk6, mk7, mk17, mk33, mk39, mk42, mk44, mk50, mk85, wm4
}

struct ArmorSpec: Identifiable {
    let id: Int
    let code: String
    let name: String
    let variant: ArmorVariant
    let primary: Color
    let primaryDark: Color
    let primaryBright: Color
    let faceplate: Color
    let faceplateDark: Color
    let faceplateBright: Color
    let eyeColor: Color
    let eyeGlow: Color
    let trim: Color
}

/// 与 Desktop / Android 端完全一致的 12 款钢铁侠机甲有序列表。
let armorModels: [ArmorSpec] = [
    ArmorSpec(id: 0, code: "MK-III", name: "Mark III", variant: .mk3, primary: hexColor("#A7262D"), primaryDark: hexColor("#5B1015"), primaryBright: hexColor("#D6454D"), faceplate: hexColor("#D8B467"), faceplateDark: hexColor("#8C6927"), faceplateBright: hexColor("#F6DF9D"), eyeColor: hexColor("#8BE9FF"), eyeGlow: hexColor("#43C9FF"), trim: hexColor("#221417")),
    ArmorSpec(id: 1, code: "MK-V", name: "Mark V", variant: .mk5, primary: hexColor("#B42B33"), primaryDark: hexColor("#631218"), primaryBright: hexColor("#E04E56"), faceplate: hexColor("#C9D2DC"), faceplateDark: hexColor("#758291"), faceplateBright: hexColor("#F1F5F9"), eyeColor: hexColor("#8BE9FF"), eyeGlow: hexColor("#4BC6FF"), trim: hexColor("#252B34")),
    ArmorSpec(id: 2, code: "MK-VI", name: "Mark VI", variant: .mk6, primary: hexColor("#9E1F27"), primaryDark: hexColor("#530C11"), primaryBright: hexColor("#CF3C46"), faceplate: hexColor("#DCBA6F"), faceplateDark: hexColor("#8B6826"), faceplateBright: hexColor("#F7E4A8"), eyeColor: hexColor("#76ECFF"), eyeGlow: hexColor("#2FD8FF"), trim: hexColor("#1D1114")),
    ArmorSpec(id: 3, code: "MK-VII", name: "Mark VII", variant: .mk7, primary: hexColor("#982028"), primaryDark: hexColor("#4F0D12"), primaryBright: hexColor("#C93A43"), faceplate: hexColor("#D2AE61"), faceplateDark: hexColor("#7E5D20"), faceplateBright: hexColor("#F1D893"), eyeColor: hexColor("#96EEFF"), eyeGlow: hexColor("#48D3FF"), trim: hexColor("#2A2224")),
    ArmorSpec(id: 4, code: "MK-XVII", name: "Heartbreaker", variant: .mk17, primary: hexColor("#7F1A22"), primaryDark: hexColor("#3F090E"), primaryBright: hexColor("#B3303A"), faceplate: hexColor("#C49D52"), faceplateDark: hexColor("#73531B"), faceplateBright: hexColor("#E8C982"), eyeColor: hexColor("#78E6FF"), eyeGlow: hexColor("#32C8FF"), trim: hexColor("#1B1417")),
    ArmorSpec(id: 5, code: "MK-XXXIII", name: "Silver Centurion", variant: .mk33, primary: hexColor("#941D26"), primaryDark: hexColor("#4C0B10"), primaryBright: hexColor("#C73540"), faceplate: hexColor("#D4DCE4"), faceplateDark: hexColor("#7C8998"), faceplateBright: hexColor("#F4F8FB"), eyeColor: hexColor("#84EBFF"), eyeGlow: hexColor("#3BCAFF"), trim: hexColor("#232830")),
    ArmorSpec(id: 6, code: "MK-XXXIX", name: "Starboost", variant: .mk39, primary: hexColor("#D8DEE6"), primaryDark: hexColor("#808B99"), primaryBright: hexColor("#F6F9FC"), faceplate: hexColor("#C6A55C"), faceplateDark: hexColor("#775B21"), faceplateBright: hexColor("#EAD08D"), eyeColor: hexColor("#7DEAFF"), eyeGlow: hexColor("#35CCFF"), trim: hexColor("#273140")),
    ArmorSpec(id: 7, code: "MK-XLII", name: "Mark XLII", variant: .mk42, primary: hexColor("#D4B36A"), primaryDark: hexColor("#856628"), primaryBright: hexColor("#F3DC9D"), faceplate: hexColor("#9D242B"), faceplateDark: hexColor("#520E12"), faceplateBright: hexColor("#CD4048"), eyeColor: hexColor("#90EEFF"), eyeGlow: hexColor("#46D0FF"), trim: hexColor("#2B1D17")),
    ArmorSpec(id: 8, code: "MK-XLIV", name: "Hulkbuster", variant: .mk44, primary: hexColor("#8E1C23"), primaryDark: hexColor("#480A0F"), primaryBright: hexColor("#C2363E"), faceplate: hexColor("#CFA95C"), faceplateDark: hexColor("#7E5C1F"), faceplateBright: hexColor("#EED18A"), eyeColor: hexColor("#98F2FF"), eyeGlow: hexColor("#48D6FF"), trim: hexColor("#2C1C1B")),
    ArmorSpec(id: 9, code: "MK-L", name: "Mark L Nano", variant: .mk50, primary: hexColor("#B3212A"), primaryDark: hexColor("#5D0C12"), primaryBright: hexColor("#E3414C"), faceplate: hexColor("#DFC074"), faceplateDark: hexColor("#8E6D29"), faceplateBright: hexColor("#FAEAAD"), eyeColor: hexColor("#7BF3FF"), eyeGlow: hexColor("#27DFFF"), trim: hexColor("#1D151D")),
    ArmorSpec(id: 10, code: "MK-LXXXV", name: "Mark LXXXV", variant: .mk85, primary: hexColor("#8D1922"), primaryDark: hexColor("#46080D"), primaryBright: hexColor("#BF313B"), faceplate: hexColor("#D6B15F"), faceplateDark: hexColor("#825F1E"), faceplateBright: hexColor("#F4D98D"), eyeColor: hexColor("#86ECFF"), eyeGlow: hexColor("#38CFFF"), trim: hexColor("#1E1316")),
    ArmorSpec(id: 11, code: "WM-MK4", name: "War Machine", variant: .wm4, primary: hexColor("#3F4752"), primaryDark: hexColor("#1C2128"), primaryBright: hexColor("#6B7787"), faceplate: hexColor("#7A8492"), faceplateDark: hexColor("#434B56"), faceplateBright: hexColor("#A9B3C1"), eyeColor: hexColor("#FF525C"), eyeGlow: hexColor("#E52432"), trim: hexColor("#13171D")),
]

/// 确定性 FNV-1a 32-bit 哈希（UTF-8 字节），与 Desktop / Android 完全一致。
func fnv1a32(_ input: String) -> UInt32 {
    var hash: UInt32 = 0x811c9dc5
    for byte in input.utf8 {
        hash ^= UInt32(byte)
        hash = hash &* 0x01000193
    }
    return hash
}

func armorIndex(for seed: String) -> Int {
    Int(fnv1a32(seed) % UInt32(armorModels.count))
}

func armorSpec(for seed: String) -> ArmorSpec {
    armorModels[armorIndex(for: seed)]
}

@MainActor
@Observable
final class SkinStore {
    static let shared = SkinStore()
    private static let key = "pibot.skin"

    var skin: AppSkin {
        didSet {
            UserDefaults.standard.set(skin.rawValue, forKey: Self.key)
            syncAppIcon(for: skin)
        }
    }

    var introToken: Int? = nil

    private init() {
        let initial = AppSkin.fromWire(UserDefaults.standard.string(forKey: Self.key))
        self.skin = initial
        if initial == .ironman {
            self.introToken = 1
        }
    }

    func applyFromServer(_ wire: String?) {
        let next = AppSkin.fromWire(wire)
        if skin != next {
            skin = next
        } else {
            syncAppIcon(for: next)
        }
    }

    func previewIntro() {
        introToken = (introToken ?? 0) + 1
    }

    /// 联动切换 iOS 主屏幕应用图标（仅在目标图标与当前图标不同且支持替换时调用）。
    func syncAppIcon(for target: AppSkin) {
        let app = UIApplication.shared
        guard app.supportsAlternateIcons else { return }
        let desiredName: String? = (target == .ironman) ? "AppIconIronMan" : nil
        guard app.alternateIconName != desiredName else { return }
        app.setAlternateIconName(desiredName) { _ in }
    }
}
