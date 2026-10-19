import React, { useEffect, useMemo, useRef, useState } from "react";
import { BotEngine, type BotInteraction, type EngineOptions } from "./engine.js";
import { drawBot } from "./render.js";
import type { Avatar, Mood } from "./spec.js";

export interface PiBotProps {
  avatar: Avatar;
  mood: Mood;
  size: number;
  /** Eyes follow the pointer while it is over the character. */
  followPointer?: boolean;
  /** Opt-in accents for avatars displayed in conversation rows. */
  motionProfile?: EngineOptions["motionProfile"];
  interaction?: BotInteraction;
  paused?: boolean;
  label?: string;
  className?: string;
  onClick?: () => void;
}
const reduced = () =>
  typeof matchMedia === "function" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches;

export function PiBot({
  avatar,
  mood,
  size,
  followPointer = false,
  motionProfile = "default",
  interaction,
  paused = false,
  label,
  className,
  onClick,
}: PiBotProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [reduceMotion, setReduceMotion] = useState(reduced);
  // Mood and interaction update the existing engine without restarting its clock.
  const engine = useMemo(() => new BotEngine(mood, {
    seed: Math.floor(Math.random() * 1e9),
    reduceMotion: reduced(),
    motionProfile,
  }), [motionProfile]);
  const repaint = useRef<(() => void) | null>(null);
  const look = useRef(avatar);
  look.current = avatar;
  useEffect(() => {
    engine.setMood(mood);
    repaint.current?.();
  }, [engine, mood]);
  useEffect(() => {
    engine.setInteraction(interaction ?? { active: false });
    repaint.current?.();
  }, [engine, interaction]);
  useEffect(() => {
    if (motionProfile !== "list" || typeof matchMedia !== "function") return;
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      engine.setReducedMotion(media.matches);
      setReduceMotion(media.matches);
      repaint.current?.();
    };
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [engine, motionProfile]);
  useEffect(() => { repaint.current?.(); }, [avatar]);
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const ctx = el.getContext("2d");
    if (!ctx) return;
    const ratio = Math.min(3, window.devicePixelRatio || 1);
    el.width = Math.round(size * ratio);
    el.height = Math.round(size * ratio);
    let frame = 0,
      last = performance.now();
    const animate = !paused && !(motionProfile === "list" && reduceMotion);
    const draw = () => {
      // A reduced-motion list frame must settle its gaze without advancing time.
      if (motionProfile === "list" && reduceMotion) engine.step(0);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, size, size);
      drawBot(ctx, engine.frame(), look.current, size);
    };
    const render = (now: number) => {
      frame = 0;
      if (document.hidden) return;
      engine.step((now - last) / 1000);
      last = now;
      draw();
      if (animate) frame = requestAnimationFrame(render);
    };
    const resume = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      last = performance.now();
      if (document.hidden) return;
      draw();
      if (animate) frame = requestAnimationFrame(render);
    };
    repaint.current = draw;
    document.addEventListener("visibilitychange", resume);
    resume();
    return () => {
      cancelAnimationFrame(frame);
      repaint.current = null;
      document.removeEventListener("visibilitychange", resume);
    };
  }, [engine, size, paused, motionProfile, reduceMotion]);
  const move = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!followPointer) return;
    const r = event.currentTarget.getBoundingClientRect();
    engine.look({
      x: ((event.clientX - r.left) / r.width) * 2 - 1,
      y: ((event.clientY - r.top) / r.height) * 2 - 1,
    });
  };
  return (
    <canvas
      ref={canvas}
      className={className}
      role="img"
      aria-label={label ?? "Pi Bot"}
      style={{ width: size, height: size, display: "block" }}
      onPointerMove={move}
      onPointerLeave={() => { if (followPointer) engine.look(null); }}
      onClick={() => {
        if (motionProfile !== "list") engine.bounce();
        onClick?.();
      }}
    />
  );
}
