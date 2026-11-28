import { useEffect, useState } from 'react';
import { bridge, call } from './bridge.js';
import { IronManAvatar } from './ironman-avatar.js';

export type AppSkin = 'default' | 'ironman';

export interface ArmorSpec {
  id: number;
  code: string;
  name: string;
  primary: string;
  primaryDark: string;
  primaryBright: string;
  faceplate: string;
  faceplateDark: string;
  faceplateBright: string;
  eyeColor: string;
  eyeGlow: string;
  trim: string;
  variant:
    | 'mk3'
    | 'mk5'
    | 'mk6'
    | 'mk7'
    | 'mk17'
    | 'mk33'
    | 'mk39'
    | 'mk42'
    | 'mk44'
    | 'mk50'
    | 'mk85'
    | 'wm4';
}

/**
 * 12 款钢铁侠机甲有序列表（与 Android / iOS 端完全一致）。
 * 未来只允许尾部追加，不可重排，以保证历史 Bot 头像映射永久稳定。
 */
export const ARMOR_MODELS: readonly ArmorSpec[] = [
  {
    id: 0, code: 'MK-III', name: 'Mark III', variant: 'mk3',
    primary: '#a7262d', primaryDark: '#5b1015', primaryBright: '#d6454d',
    faceplate: '#d8b467', faceplateDark: '#8c6927', faceplateBright: '#f6df9d',
    eyeColor: '#8be9ff', eyeGlow: '#43c9ff', trim: '#221417',
  },
  {
    id: 1, code: 'MK-V', name: 'Mark V', variant: 'mk5',
    primary: '#b42b33', primaryDark: '#631218', primaryBright: '#e04e56',
    faceplate: '#c9d2dc', faceplateDark: '#758291', faceplateBright: '#f1f5f9',
    eyeColor: '#8be9ff', eyeGlow: '#4bc6ff', trim: '#252b34',
  },
  {
    id: 2, code: 'MK-VI', name: 'Mark VI', variant: 'mk6',
    primary: '#9e1f27', primaryDark: '#530c11', primaryBright: '#cf3c46',
    faceplate: '#dcba6f', faceplateDark: '#8b6826', faceplateBright: '#f7e4a8',
    eyeColor: '#76ecff', eyeGlow: '#2fd8ff', trim: '#1d1114',
  },
  {
    id: 3, code: 'MK-VII', name: 'Mark VII', variant: 'mk7',
    primary: '#982028', primaryDark: '#4f0d12', primaryBright: '#c93a43',
    faceplate: '#d2ae61', faceplateDark: '#7e5d20', faceplateBright: '#f1d893',
    eyeColor: '#96eeff', eyeGlow: '#48d3ff', trim: '#2a2224',
  },
  {
    id: 4, code: 'MK-XVII', name: 'Heartbreaker', variant: 'mk17',
    primary: '#7f1a22', primaryDark: '#3f090e', primaryBright: '#b3303a',
    faceplate: '#c49d52', faceplateDark: '#73531b', faceplateBright: '#e8c982',
    eyeColor: '#78e6ff', eyeGlow: '#32c8ff', trim: '#1b1417',
  },
  {
    id: 5, code: 'MK-XXXIII', name: 'Silver Centurion', variant: 'mk33',
    primary: '#941d26', primaryDark: '#4c0b10', primaryBright: '#c73540',
    faceplate: '#d4dce4', faceplateDark: '#7c8998', faceplateBright: '#f4f8fb',
    eyeColor: '#84ebff', eyeGlow: '#3bcaff', trim: '#232830',
  },
  {
    id: 6, code: 'MK-XXXIX', name: 'Starboost', variant: 'mk39',
    primary: '#d8dee6', primaryDark: '#808b99', primaryBright: '#f6f9fc',
    faceplate: '#c6a55c', faceplateDark: '#775b21', faceplateBright: '#ead08d',
    eyeColor: '#7deaff', eyeGlow: '#35ccff', trim: '#273140',
  },
  {
    id: 7, code: 'MK-XLII', name: 'Mark XLII', variant: 'mk42',
    primary: '#d4b36a', primaryDark: '#856628', primaryBright: '#f3dc9d',
    faceplate: '#9d242b', faceplateDark: '#520e12', faceplateBright: '#cd4048',
    eyeColor: '#90eeff', eyeGlow: '#46d0ff', trim: '#2b1d17',
  },
  {
    id: 8, code: 'MK-XLIV', name: 'Hulkbuster', variant: 'mk44',
    primary: '#8e1c23', primaryDark: '#480a0f', primaryBright: '#c2363e',
    faceplate: '#cfa95c', faceplateDark: '#7e5c1f', faceplateBright: '#eed18a',
    eyeColor: '#98f2ff', eyeGlow: '#48d6ff', trim: '#2c1c1b',
  },
  {
    id: 9, code: 'MK-L', name: 'Mark L Nano', variant: 'mk50',
    primary: '#b3212a', primaryDark: '#5d0c12', primaryBright: '#e3414c',
    faceplate: '#dfc074', faceplateDark: '#8e6d29', faceplateBright: '#faeaad',
    eyeColor: '#7bf3ff', eyeGlow: '#27dfff', trim: '#1d151d',
  },
  {
    id: 10, code: 'MK-LXXXV', name: 'Mark LXXXV', variant: 'mk85',
    primary: '#8d1922', primaryDark: '#46080d', primaryBright: '#bf313b',
    faceplate: '#d6b15f', faceplateDark: '#825f1e', faceplateBright: '#f4d98d',
    eyeColor: '#86ecff', eyeGlow: '#38cfff', trim: '#1e1316',
  },
  {
    id: 11, code: 'WM-MK4', name: 'War Machine', variant: 'wm4',
    primary: '#3f4752', primaryDark: '#1c2128', primaryBright: '#6b7787',
    faceplate: '#7a8492', faceplateDark: '#434b56', faceplateBright: '#a9b3c1',
    eyeColor: '#ff525c', eyeGlow: '#e52432', trim: '#13171d',
  },
];

/**
 * 确定性 FNV-1a 32-bit 哈希（UTF-8 字节），与 Android / iOS 完全一致。
 */
export function fnv1a32(input: string): number {
  const bytes = new TextEncoder().encode(input);
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i]!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function armorIndexFor(seed: string): number {
  return fnv1a32(seed) % ARMOR_MODELS.length;
}

export function armorFor(seed: string): ArmorSpec {
  return ARMOR_MODELS[armorIndexFor(seed)]!;
}

const SKIN_KEY = 'pi-bot.skin';

function parseSkin(value: unknown): AppSkin {
  return value === 'ironman' ? 'ironman' : 'default';
}

function storedSkin(): AppSkin {
  try {
    return parseSkin(localStorage.getItem(SKIN_KEY));
  } catch {
    return 'default';
  }
}

let currentSkin: AppSkin = storedSkin();
const listeners = new Set<() => void>();

function applySkin(skin: AppSkin, persistLocal = true) {
  currentSkin = skin;
  if (skin === 'default') {
    delete document.documentElement.dataset.skin;
  } else {
    document.documentElement.dataset.skin = skin;
  }
  if (persistLocal) {
    try {
      localStorage.setItem(SKIN_KEY, skin);
    } catch {
      /* Ignore storage quota/privacy failures; skin still works in memory. */
    }
  }
  try {
    void bridge.setAppIcon?.(skin)?.catch(() => {});
  } catch {
    /* Non-Electron environments (e.g. unit tests / browser preview) have no desktop bridge. */
  }
  listeners.forEach(listener => listener());
}

// 冷启动即刻同步 data-skin，避免首帧闪烁。
applySkin(currentSkin, false);

window.addEventListener('storage', event => {
  if (event.key !== SKIN_KEY && event.key !== null) return;
  applySkin(storedSkin(), false);
});

export function getSkin(): AppSkin {
  return currentSkin;
}

export function useSkin(): AppSkin {
  const [skin, setLocal] = useState<AppSkin>(currentSkin);
  useEffect(() => {
    const update = () => setLocal(currentSkin);
    listeners.add(update);
    update();
    return () => { listeners.delete(update); };
  }, []);
  return skin;
}

export async function setSkin(next: AppSkin): Promise<void> {
  const prev = currentSkin;
  applySkin(next, true);
  try {
    const res = await call<{ pstack_enabled: boolean; skin?: AppSkin }>('setPreferences', { skin: next });
    if (res?.skin) applySkin(parseSkin(res.skin), true);
  } catch (err) {
    // 若未登录或离线则保留本地选择；若云端明确拒绝则回退
    if (prev !== next && String(err).includes('422')) {
      applySkin(prev, true);
    }
    throw err;
  }
}

export async function syncSkinFromServer(): Promise<AppSkin> {
  const prefs = await call<{ pstack_enabled: boolean; skin?: AppSkin }>('preferences');
  const next = parseSkin(prefs?.skin);
  if (next !== currentSkin) applySkin(next, true);
  return next;
}

export function SkinPicker({ onPreviewIntro, onError }: { onPreviewIntro(): void; onError?(msg: string): void }) {
  const skin = useSkin();
  const [saving, setSaving] = useState(false);

  const choose = async (next: AppSkin) => {
    if (next === skin || saving) return;
    setSaving(true);
    try {
      await setSkin(next);
    } catch (err) {
      onError?.(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="skin-section" aria-label="皮肤与外观">
      <div className="skin-section-head">
        <h3>主题皮肤</h3>
        <span className="muted small">随账号多端同步</span>
      </div>
      <div className="skin-cards">
        <button
          type="button"
          className={`skin-card${skin === 'default' ? ' active' : ''}`}
          disabled={saving}
          aria-pressed={skin === 'default'}
          onClick={() => void choose('default')}
        >
          <span className="skin-card-head">
            <strong>默认皮肤</strong>
            <span className="skin-card-swatches" aria-hidden="true">
              <i style={{ background: '#ffffff' }} />
              <i style={{ background: '#202020' }} />
              <i style={{ background: '#268454' }} />
            </span>
          </span>
          <span className="muted small">经典中性界面与原生 Bot 表情头像</span>
        </button>
        <button
          type="button"
          className={`skin-card${skin === 'ironman' ? ' active' : ''}`}
          disabled={saving}
          aria-pressed={skin === 'ironman'}
          onClick={() => void choose('ironman')}
        >
          <span className="skin-card-head">
            <strong>钢铁侠</strong>
            <span className="skin-card-swatches" aria-hidden="true">
              <i style={{ background: '#a72b32' }} />
              <i style={{ background: '#d8b467' }} />
              <i style={{ background: '#75ddf1' }} />
            </span>
          </span>
          <span className="muted small">红金反应堆配色 · 12 款固定机甲头像</span>
        </button>
      </div>
      {skin === 'ironman' && (
        <>
          <div className="skin-armor-strip" aria-label="12 款钢铁侠机甲头像预览">
            {ARMOR_MODELS.map(armor => (
              <div key={armor.id} className="skin-armor-chip" title={armor.name}>
                <IronManAvatar seed={armor.code} armorIndex={armor.id} mood="happy" size={32} />
                <span>{armor.code}</span>
              </div>
            ))}
          </div>
          <div className="skin-actions">
            <span className="muted small">每个 Bot 按 ID 固定分配同一款机甲，不改动原头像</span>
            <button type="button" className="ghost small" onClick={onPreviewIntro}>预览入场动画</button>
          </div>
        </>
      )}
    </section>
  );
}
