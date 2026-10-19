import { spec, type Avatar, type ArmStyle, type EyeStyle } from "./spec.js";
import { smoothOutline } from "./geometry.js";
import type { Frame } from "./engine.js";

type Ctx = CanvasRenderingContext2D;
export interface DrawOptions {
  shadow?: boolean;
  effects?: boolean;
}
/** Unit space: the body spans roughly -1..1 and is drawn at `size * SCALE`. */
export const SCALE = 0.34;
export const CENTER_Y = 0.56;

export function armAngle(style: ArmStyle, side: -1 | 1, t: number): number {
  switch (style) {
    case "wave":
      return side > 0 ? 2.4 + Math.sin(t * 9) * 0.35 : 0.4;
    case "up":
      return 2.5 + Math.sin(t * 7 + side) * 0.2;
    case "type":
      return 0.95 + Math.sin(t * 16 + (side > 0 ? 0 : Math.PI)) * 0.15;
    case "think":
      return side > 0 ? 2.1 : 0.35;
    default:
      return 0.35 + Math.sin(t * 2 + side) * 0.05;
  }
}

export function drawBot(
  ctx: Ctx,
  frame: Frame,
  avatar: Avatar,
  size: number,
  options: DrawOptions = {},
) {
  const shape = spec.shapes[avatar.shape],
    color = spec.colors[avatar.color],
    mood = spec.moods[frame.mood];
  const [top, bottom] = color[avatar.scheme];
  const ink = color.ink;
  const t = frame.t;
  ctx.save();
  ctx.translate(size / 2, size * CENTER_Y);
  ctx.scale(size * SCALE, size * SCALE);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (options.shadow !== false) {
    const lift = Math.min(0.5, Math.abs(frame.offsetY) * 3);
    ctx.fillStyle = "rgba(0,0,0,0.12)";
    ctx.beginPath();
    ctx.ellipse(0, 0.98, 0.62 * (1 - lift), 0.075 * (1 - lift), 0, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.save();
  ctx.translate(0, frame.offsetY);
  ctx.rotate(frame.rotation);
  ctx.translate(0, 0.8);
  ctx.scale(frame.scaleX, frame.scaleY);
  ctx.translate(0, -0.8);

  // Feet sit behind the body so only the toes peek out.
  ctx.fillStyle = bottom;
  for (const side of [-1, 1] as const) {
    ctx.beginPath();
    ctx.ellipse(side * 0.32, 0.84, 0.17, 0.1, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  if (mood.arms !== "hidden") {
    ctx.strokeStyle = bottom;
    ctx.lineWidth = 0.2;
    for (const side of [-1, 1] as const) {
      let a = armAngle(mood.arms, side, t);
      if (mood.arms === "type") a = 0.95 + (a - 0.95) * (frame.armActivity ?? 1);
      if (frame.wave) a += (armAngle("wave", side, t) - a) * frame.wave;
      const sx = side * 0.68,
        sy = 0.18;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx + side * Math.sin(a) * 0.34, sy + Math.cos(a) * 0.34);
      ctx.stroke();
    }
  }

  const outline = smoothOutline(shape.points);
  const gradient = ctx.createLinearGradient(0, -0.95, 0, 0.9);
  gradient.addColorStop(0, top);
  gradient.addColorStop(1, bottom);
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.moveTo(outline.start[0], outline.start[1]);
  for (const [c1, c2, p] of outline.segments)
    ctx.bezierCurveTo(c1[0], c1[1], c2[0], c2[1], p[0], p[1]);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = "rgba(255,255,255,0.26)";
  ctx.beginPath();
  ctx.ellipse(-0.34, -0.46, 0.22, 0.12, -0.55, 0, Math.PI * 2);
  ctx.fill();

  const { y: fy, gap, eye } = shape.face;
  ctx.globalAlpha = 0.45;
  ctx.fillStyle = color.cheek;
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(side * (gap / 2 + 0.13), fy + 0.17, 0.1, 0.06, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  const gx = frame.gazeX * 0.06,
    gy = frame.gazeY * 0.05;
  for (const side of [-1, 1] as const) {
    const style: EyeStyle =
      mood.eyes === "wink" ? (side < 0 ? "open" : "happy") : mood.eyes;
    drawEye(ctx, style, side * (gap / 2) + gx, fy + gy, eye, frame.blink, ink);
  }
  drawMouth(ctx, mood.mouth, gx * 0.5, fy + 0.2 + gy * 0.5, ink);
  ctx.restore();

  if (options.effects !== false) drawEffect(ctx, mood.effect, t, ink, bottom);
  for (const p of frame.particles) {
    ctx.save();
    ctx.globalAlpha = Math.min(1, p.life / 0.4);
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rotation);
    ctx.fillStyle = spec.confetti[p.color % spec.confetti.length];
    ctx.fillRect(-0.035, -0.018, 0.07, 0.036);
    ctx.restore();
  }
  ctx.restore();
}

function drawEye(
  ctx: Ctx,
  style: EyeStyle,
  x: number,
  y: number,
  e: number,
  blink: number,
  ink: string,
) {
  ctx.fillStyle = ink;
  ctx.strokeStyle = ink;
  ctx.lineWidth = e * 0.38;
  const open = 1 - blink * 0.9;
  switch (style) {
    case "happy":
      ctx.beginPath();
      ctx.moveTo(x - e * 0.75, y + e * 0.25);
      ctx.quadraticCurveTo(x, y - e * 0.9, x + e * 0.75, y + e * 0.25);
      ctx.stroke();
      return;
    case "closed":
      ctx.beginPath();
      ctx.moveTo(x - e * 0.8, y - e * 0.1);
      ctx.quadraticCurveTo(x, y + e * 0.75, x + e * 0.8, y - e * 0.1);
      ctx.stroke();
      return;
    case "small":
      ctx.beginPath();
      ctx.ellipse(x, y, e * 0.42, e * 0.48 * open, 0, 0, Math.PI * 2);
      ctx.fill();
      return;
    default: {
      const ry = e * (style === "focus" ? 0.6 : 1) * open;
      ctx.beginPath();
      ctx.ellipse(x, y, e * 0.72, Math.max(ry, e * 0.08), 0, 0, Math.PI * 2);
      ctx.fill();
      if (blink < 0.5 && ink !== "#F5F5F7") {
        ctx.fillStyle = "rgba(255,255,255,0.9)";
        ctx.beginPath();
        ctx.arc(x + e * 0.22, y - ry * 0.38, e * 0.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

function drawMouth(ctx: Ctx, style: string, x: number, y: number, ink: string) {
  ctx.fillStyle = ink;
  ctx.strokeStyle = ink;
  ctx.lineWidth = 0.034;
  ctx.beginPath();
  switch (style) {
    case "open":
      ctx.moveTo(x - 0.11, y - 0.02);
      ctx.quadraticCurveTo(x, y + 0.17, x + 0.11, y - 0.02);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "#FF7A85";
      ctx.beginPath();
      ctx.ellipse(x, y + 0.055, 0.045, 0.022, 0, 0, Math.PI * 2);
      ctx.fill();
      return;
    case "flat":
      ctx.moveTo(x - 0.07, y + 0.02);
      ctx.lineTo(x + 0.07, y + 0.02);
      break;
    case "o":
      ctx.ellipse(x, y + 0.03, 0.045, 0.055, 0, 0, Math.PI * 2);
      ctx.fill();
      return;
    case "frown":
      ctx.moveTo(x - 0.08, y + 0.05);
      ctx.quadraticCurveTo(x, y - 0.03, x + 0.08, y + 0.05);
      break;
    default:
      ctx.moveTo(x - 0.09, y - 0.01);
      ctx.quadraticCurveTo(x, y + 0.08, x + 0.09, y - 0.01);
  }
  ctx.stroke();
}

function drawEffect(ctx: Ctx, effect: string, t: number, ink: string, accent: string) {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  switch (effect) {
    case "dots":
      for (let i = 0; i < 3; i++) {
        ctx.globalAlpha = 0.25 + 0.75 * Math.max(0, Math.sin(t * 4 - i * 0.8));
        ctx.fillStyle = "#8A8F98";
        ctx.beginPath();
        ctx.arc(0.6 + i * 0.15, -0.95 - i * 0.06, 0.045 + i * 0.012, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      return;
    case "question": {
      const y = -1.0 + Math.sin(t * 3) * 0.04;
      ctx.strokeStyle = accent;
      ctx.fillStyle = accent;
      ctx.lineWidth = 0.07;
      ctx.beginPath();
      ctx.arc(0.8, y, 0.11, Math.PI * 1.1, Math.PI * 2.35);
      ctx.lineTo(0.8, y + 0.2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0.8, y + 0.32, 0.04, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    case "alert": {
      const y = -1.05 + Math.sin(t * 6) * 0.025;
      ctx.strokeStyle = "#F04438";
      ctx.fillStyle = "#F04438";
      ctx.lineWidth = 0.08;
      ctx.beginPath();
      ctx.moveTo(0.8, y);
      ctx.lineTo(0.8, y + 0.24);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0.8, y + 0.37, 0.045, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    case "zzz":
      ctx.strokeStyle = ink === "#F5F5F7" ? "#9CA3AF" : "#6B7280";
      for (let i = 0; i < 3; i++) {
        const phase = (t * 0.45 + i / 3) % 1;
        const s = 0.08 + phase * 0.08,
          x = 0.5 + phase * 0.38,
          y = -0.72 - phase * 0.5;
        ctx.globalAlpha = Math.sin(phase * Math.PI);
        ctx.lineWidth = 0.035;
        ctx.beginPath();
        ctx.moveTo(x - s, y - s);
        ctx.lineTo(x + s, y - s);
        ctx.lineTo(x - s, y + s);
        ctx.lineTo(x + s, y + s);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      return;
    case "sparkle":
      ctx.fillStyle = "#FFD166";
      for (let i = 0; i < 3; i++) {
        const s = (0.05 + 0.04 * Math.max(0, Math.sin(t * 5 + i * 2.1))) ;
        const [x, y] = [[-0.85, -0.75], [0.88, -0.6], [0.6, -1.02]][i];
        ctx.beginPath();
        ctx.moveTo(x, y - s * 2);
        ctx.quadraticCurveTo(x, y, x + s * 2, y);
        ctx.quadraticCurveTo(x, y, x, y + s * 2);
        ctx.quadraticCurveTo(x, y, x - s * 2, y);
        ctx.quadraticCurveTo(x, y, x, y - s * 2);
        ctx.fill();
      }
      return;
  }
}
