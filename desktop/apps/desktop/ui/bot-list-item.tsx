import { useState, type MouseEvent, type PointerEvent } from 'react';
import { PiBot } from '@pi-bot/bot-face/react';
import { spec, type Mood } from '@pi-bot/bot-face';
import type { Bot } from '../../../packages/protocol/src/index.js';

export function BotListItem({ bot, mood, summary, selected, onSelect, onContextMenu }: {
  bot: Bot;
  mood: Mood;
  summary: string;
  selected: boolean;
  onSelect(): void;
  onContextMenu(event: MouseEvent<HTMLButtonElement>): void;
}) {
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const [focused, setFocused] = useState(false);
  const track = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === 'touch') return;
    const rect = event.currentTarget.getBoundingClientRect();
    setPointer({
      x: ((event.clientX - rect.left) / rect.width) * 2 - 1,
      y: ((event.clientY - rect.top) / rect.height) * 2 - 1,
    });
  };
  return (
    <button
      className={`bot-item ${bot.is_main ? 'main-bot' : ''} ${selected ? 'active' : ''}`}
      aria-pressed={selected}
      onClick={onSelect}
      onContextMenu={event => { event.preventDefault(); onContextMenu(event); }}
      onPointerEnter={track}
      onPointerMove={track}
      onPointerLeave={() => setPointer(null)}
      onPointerCancel={() => setPointer(null)}
      onPointerDown={() => setFocused(false)}
      onFocus={event => setFocused(event.currentTarget.matches(':focus-visible'))}
      onBlur={() => setFocused(false)}
    >
      <span className="bot-avatar">
        <PiBot
          avatar={bot.avatar}
          mood={mood}
          size={bot.is_main ? 64 : 44}
          motionProfile="list"
          interaction={{ active: pointer !== null || focused, pointer }}
          label={`${bot.name} · ${spec.moods[mood].label}`}
        />
        {bot.is_main && <span className="main-star" aria-label="主智能体">★</span>}
      </span>
      <span className="bot-text">
        <strong>{bot.name}</strong>
        <span className={bot.pending_approvals.length ? 'attention' : ''}>{summary}</span>
      </span>
      {bot.pending_approvals.length > 0 && <i className="badge-dot" />}
    </button>
  );
}
