import { useMemo } from 'react';
import { PiBot as BotFace, type PiBotProps } from '@pi-bot/bot-face/react';
import { COLORS, type Avatar } from '@pi-bot/bot-face';
import { useSkin } from './skin.js';
import { IronManAvatar } from './ironman-avatar.js';

// Keep avatars colorful in both interface themes. Older saved colors remain
// readable without rewriting the account's avatar settings in the background.
export const AVATAR_COLORS = COLORS.filter(color => color !== 'ink' && color !== 'cocoa');
export function colorfulAvatar(avatar: Avatar): Avatar {
  const color = avatar.color === 'ink' ? 'sky' : avatar.color === 'cocoa' ? 'orange' : avatar.color;
  return color === avatar.color && avatar.scheme === 'light' ? avatar : { ...avatar, color, scheme: 'light' };
}

export interface SkinnedPiBotProps extends PiBotProps {
  /** 稳定的 Bot ID，用于钢铁侠皮肤下确定性映射到固定机甲 */
  botId?: string;
  /** 强制使用原始头像（例如 Bot 编辑器里挑选原始形状/颜色） */
  forceOriginal?: boolean;
}

export function PiBot({ avatar, botId, forceOriginal = false, ...props }: SkinnedPiBotProps) {
  const skin = useSkin();
  const colorful = useMemo(() => colorfulAvatar(avatar), [avatar]);
  if (!forceOriginal && skin === 'ironman') {
    const seed = botId || `${avatar.shape}:${avatar.color}:${avatar.scheme}`;
    return (
      <IronManAvatar
        seed={seed}
        mood={props.mood}
        size={props.size}
        label={props.label}
        className={props.className}
      />
    );
  }
  return <BotFace {...props} avatar={colorful} />;
}
