import { useId, useMemo } from 'react';
import type { Mood } from '@pi-bot/bot-face';
import { ARMOR_MODELS, armorFor, type ArmorSpec } from './skin.js';

export interface IronManAvatarProps {
  seed: string;
  armorIndex?: number;
  mood?: Mood;
  size?: number;
  label?: string;
  className?: string;
}

function moodEyeStyle(mood: Mood | undefined) {
  switch (mood) {
    case 'sleeping':
      return { opacity: 0.35, scaleY: 0.45, glow: 0.25 };
    case 'working':
    case 'thinking':
      return { opacity: 1, scaleY: 1.05, glow: 1.0 };
    case 'celebrate':
    case 'happy':
      return { opacity: 0.96, scaleY: 0.95, glow: 0.85 };
    case 'waiting':
    case 'error':
      return { opacity: 1, scaleY: 1.12, glow: 1.1 };
    default:
      return { opacity: 0.88, scaleY: 0.92, glow: 0.7 };
  }
}

export function IronManAvatar({ seed, armorIndex, mood = 'idle', size = 48, label, className }: IronManAvatarProps) {
  const uid = useId().replace(/:/g, '');
  const armor: ArmorSpec = useMemo(() => {
    if (typeof armorIndex === 'number' && armorIndex >= 0 && armorIndex < ARMOR_MODELS.length) {
      return ARMOR_MODELS[armorIndex]!;
    }
    return armorFor(seed);
  }, [seed, armorIndex]);

  const eye = moodEyeStyle(mood);
  const isWide = armor.variant === 'mk44' || armor.variant === 'mk17';
  const isNano = armor.variant === 'mk50' || armor.variant === 'mk85';
  const isStriped = armor.variant === 'mk5';
  const isSharp = armor.variant === 'mk6' || armor.variant === 'mk33';
  const isTactical = armor.variant === 'wm4' || armor.variant === 'mk7';
  const isSpace = armor.variant === 'mk39';
  const isSplit = armor.variant === 'mk42';
  const eyeColor = mood === 'error' ? '#ff5b5b' : mood === 'waiting' ? '#ffc154' : armor.eyeColor;
  const eyeGlow = mood === 'error' ? '#ff2b2b' : mood === 'waiting' ? '#ff9f1c' : armor.eyeGlow;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      className={className ? `ironman-avatar ${className}` : 'ironman-avatar'}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{ display: 'inline-block', flexShrink: 0, overflow: 'visible' }}
    >
      <defs>
        <radialGradient id={`${uid}-bg`} cx="35%" cy="25%" r="75%">
          <stop offset="0%" stopColor="#1b2638" />
          <stop offset="65%" stopColor="#0f1521" />
          <stop offset="100%" stopColor="#080b12" />
        </radialGradient>
        <linearGradient id={`${uid}-shell`} x1="15%" y1="6%" x2="85%" y2="94%">
          <stop offset="0%" stopColor={armor.primaryBright} />
          <stop offset="42%" stopColor={armor.primary} />
          <stop offset="100%" stopColor={armor.primaryDark} />
        </linearGradient>
        <linearGradient id={`${uid}-face`} x1="18%" y1="10%" x2="82%" y2="90%">
          <stop offset="0%" stopColor={armor.faceplateBright} />
          <stop offset="48%" stopColor={armor.faceplate} />
          <stop offset="100%" stopColor={armor.faceplateDark} />
        </linearGradient>
        <linearGradient id={`${uid}-spec`} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.45" />
          <stop offset="45%" stopColor="#ffffff" stopOpacity="0.06" />
          <stop offset="100%" stopColor="#000000" stopOpacity="0.22" />
        </linearGradient>
        <radialGradient id={`${uid}-glow`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={eyeGlow} stopOpacity={0.75 * eye.glow} />
          <stop offset="100%" stopColor={eyeGlow} stopOpacity="0" />
        </radialGradient>
        <filter id={`${uid}-eyefilter`} x="-40%" y="-80%" width="180%" height="260%">
          <feGaussianBlur stdDeviation="2.2" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* 深海钛圆底 + 金属环 */}
      <circle cx="50" cy="50" r="47" fill={`url(#${uid}-bg)`} stroke={armor.faceplate} strokeOpacity="0.45" strokeWidth="1.8" />
      <circle cx="50" cy="50" r="43.5" fill="none" stroke={eyeGlow} strokeOpacity="0.24" strokeWidth="0.9" strokeDasharray={isTactical ? '6 3' : '14 6'} />

      {/* 重装护耳块（Hulkbuster / War Machine / Mark VII） */}
      {(isWide || isTactical) && (
        <g>
          <path d="M12 42 L20 35 L20 63 L12 58 Z" fill={`url(#${uid}-shell)`} stroke={armor.trim} strokeWidth="1.2" />
          <path d="M88 42 L80 35 L80 63 L88 58 Z" fill={`url(#${uid}-shell)`} stroke={armor.trim} strokeWidth="1.2" />
          <line x1="15" y1="44" x2="15" y2="55" stroke={armor.faceplateBright} strokeOpacity="0.5" strokeWidth="1" />
          <line x1="85" y1="44" x2="85" y2="55" stroke={armor.faceplateBright} strokeOpacity="0.5" strokeWidth="1" />
        </g>
      )}

      {/* 外壳头盔主体 */}
      <path
        d={
          isWide
            ? 'M50 11 C71 11 84 24 85 44 L81 70 C77 82 65 89 50 90 C35 89 23 82 19 70 L15 44 C16 24 29 11 50 11 Z'
            : isSharp
              ? 'M50 10 L75 21 L82 46 L76 72 L62 88 L50 91 L38 88 L24 72 L18 46 L25 21 Z'
              : 'M50 10 C68 10 80 23 81 44 L77 71 C73 83 62 89 50 90 C38 89 27 83 23 71 L19 44 C20 23 32 10 50 10 Z'
        }
        fill={`url(#${uid}-shell)`}
        stroke={armor.trim}
        strokeWidth="1.8"
      />

      {/* 顶部高光切面与额冠脊线 */}
      <path d="M36 14 L50 11 L64 14 L59 29 L41 29 Z" fill={`url(#${uid}-spec)`} />
      <path d="M40 13 L43 32 L57 32 L60 13" fill="none" stroke={armor.trim} strokeOpacity="0.7" strokeWidth="1.4" />
      {isSpace && (
        <path d="M31 20 L69 20 L65 28 L35 28 Z" fill={armor.trim} fillOpacity="0.65" />
      )}

      {/* 面甲主件（金/银/钛） */}
      <path
        d={
          isWide
            ? 'M32 28 L42 32 L58 32 L68 28 L76 46 L71 68 L62 79 L59 74 L41 74 L38 79 L29 68 L24 46 Z'
            : isNano
              ? 'M35 26 L44 33 L56 33 L65 26 L74 44 L69 69 L59 82 L55 76 L45 76 L41 82 L31 69 L26 44 Z'
              : 'M34 27 L43 32 L57 32 L66 27 L74 45 L69 68 L60 80 L56 75 L44 75 L40 80 L31 68 L26 45 Z'
        }
        fill={`url(#${uid}-face)`}
        stroke={armor.trim}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />

      {/* 额头中央倒梯形嵌入装甲 */}
      <path d="M42 21 L58 21 L55 34 L45 34 Z" fill={`url(#${uid}-shell)`} stroke={armor.trim} strokeWidth="1.2" />

      {/* 鼻梁与颧骨折面高光 */}
      <path d="M45 34 L55 34 L53 64 L47 64 Z" fill={`url(#${uid}-spec)`} opacity="0.6" />
      <path d="M27 49 L39 58 L39 74" fill="none" stroke={armor.trim} strokeOpacity="0.65" strokeWidth="1.2" />
      <path d="M73 49 L61 58 L61 74" fill="none" stroke={armor.trim} strokeOpacity="0.65" strokeWidth="1.2" />

      {/* 型号专属纹理特征 */}
      {isStriped && (
        <g stroke={armor.primary} strokeOpacity="0.72" strokeWidth="1.5">
          <line x1="29" y1="38" x2="39" y2="41" />
          <line x1="71" y1="38" x2="61" y2="41" />
          <line x1="30" y1="60" x2="39" y2="63" />
          <line x1="70" y1="60" x2="61" y2="63" />
        </g>
      )}
      {isSplit && (
        <g stroke={armor.faceplateBright} strokeOpacity="0.65" strokeWidth="1.1">
          <line x1="50" y1="34" x2="50" y2="65" />
          <line x1="33" y1="54" x2="67" y2="54" strokeOpacity="0.4" />
        </g>
      )}
      {isNano && (
        <g stroke={eyeGlow} strokeOpacity="0.7" strokeWidth="1.1">
          <path d="M37 30 L42 36" />
          <path d="M63 30 L58 36" />
          <line x1="46" y1="66" x2="54" y2="66" />
        </g>
      )}
      {isTactical && (
        <g>
          <rect x="44" y="24" width="12" height="3" rx="1" fill={eyeColor} fillOpacity="0.65" />
          <circle cx="33" cy="64" r="1.4" fill={armor.trim} />
          <circle cx="67" cy="64" r="1.4" fill={armor.trim} />
        </g>
      )}

      {/* 下颌口部机械缝 */}
      <path d="M39 71 L45 73 L55 73 L61 71 L58 84 L42 84 Z" fill={`url(#${uid}-shell)`} stroke={armor.trim} strokeWidth="1.2" />
      <path d="M41 75 L46 77 L54 77 L59 75" fill="none" stroke={armor.trim} strokeWidth="1.6" strokeLinecap="round" />

      {/* 眼部辉光晕 */}
      <ellipse cx="37.5" cy="48.5" rx="10" ry="5.5" fill={`url(#${uid}-glow)`} />
      <ellipse cx="62.5" cy="48.5" rx="10" ry="5.5" fill={`url(#${uid}-glow)`} />

      {/* 眼窝暗槽 */}
      <path d="M29.5 45.5 L45 48.2 L43 52.2 L31.2 50.8 Z" fill="#090d14" />
      <path d="M70.5 45.5 L55 48.2 L57 52.2 L68.8 50.8 Z" fill="#090d14" />

      {/* 发光护目镜片（随 mood 联动） */}
      <g
        filter={`url(#${uid}-eyefilter)`}
        opacity={eye.opacity}
        style={{ transformOrigin: '50px 49px', transform: `scaleY(${eye.scaleY})` }}
      >
        <path
          d={
            isWide
              ? 'M30.5 46.4 L44.3 48.6 L42.8 51.3 L31.8 50.1 Z'
              : 'M31.2 46.6 L44.2 48.6 L42.8 51.1 L32.2 49.9 Z'
          }
          fill={eyeColor}
        />
        <path
          d={
            isWide
              ? 'M69.5 46.4 L55.7 48.6 L57.2 51.3 L68.2 50.1 Z'
              : 'M68.8 46.6 L55.8 48.6 L57.2 51.1 L67.8 49.9 Z'
          }
          fill={eyeColor}
        />
        {/* 眼灯核心白亮线 */}
        <line x1="33" y1="48.1" x2="42.5" y2="49.5" stroke="#ffffff" strokeOpacity="0.85" strokeWidth="1.05" strokeLinecap="round" />
        <line x1="67" y1="48.1" x2="57.5" y2="49.5" stroke="#ffffff" strokeOpacity="0.85" strokeWidth="1.05" strokeLinecap="round" />
      </g>
    </svg>
  );
}
