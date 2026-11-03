import { useMemo } from 'react';
import { PiBot as BotFace, type PiBotProps } from '@pi-bot/bot-face/react';
import { COLORS, type Avatar } from '@pi-bot/bot-face';

// Keep avatars colorful in both interface themes. Older saved colors remain
// readable without rewriting the account's avatar settings in the background.
export const AVATAR_COLORS = COLORS.filter(color => color !== 'ink' && color !== 'cocoa');
export function colorfulAvatar(avatar: Avatar): Avatar {
  const color = avatar.color === 'ink' ? 'sky' : avatar.color === 'cocoa' ? 'orange' : avatar.color;
  return color === avatar.color && avatar.scheme === 'light' ? avatar : { ...avatar, color, scheme: 'light' };
}

export function PiBot({ avatar, ...props }: PiBotProps) {
  const colorful = useMemo(() => colorfulAvatar(avatar), [avatar]);
  return <BotFace {...props} avatar={colorful} />;
}
