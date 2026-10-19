import { spec, type Mood } from "./spec.js";

export interface BotInteraction {
  active: boolean;
  /** Pointer relative to the containing row, in unit space (-1..1). */
  pointer?: { x: number; y: number } | null;
}

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rotation: number;
  spin: number;
  life: number;
  maxLife: number;
  color: number;
}
export interface Frame {
  t: number;
  mood: Mood;
  /** 0 = open, 1 = fully closed. */
  blink: number;
  gazeX: number;
  gazeY: number;
  scaleX: number;
  scaleY: number;
  offsetY: number;
  rotation: number;
  particles: readonly Particle[];
  /** Optional desktop list accents; absent for the shared default profile. */
  wave?: number;
  armActivity?: number;
}
export interface EngineOptions {
  seed?: number;
  reduceMotion?: boolean;
  motionProfile?: "default" | "list";
}

/** Mulberry32: small, portable and identical on the Kotlin side. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BLINK_SECONDS = 0.16;
const MAX_PARTICLES = 80;

/**
 * Animation state machine, independent of any drawing surface.
 * The default profile is shared with Kotlin; list accents are opt-in desktop UI.
 */
export class BotEngine {
  private t = 0;
  private mood: Mood;
  private random: () => number;
  private reduceMotion: boolean;
  private nextBlink: number;
  private blinkPhase = -1;
  private gaze = { x: 0, y: 0, vx: 0, vy: 0 };
  private pointer: { x: number; y: number } | null = null;
  private hop = { y: 0, v: 0 };
  private spinLeft = 0;
  private angle = 0;
  private particles: Particle[] = [];
  private spawnDebt = 0;
  private readonly motionProfile: "default" | "list";
  private attentive = false;
  private attention = 0;
  private nodAge = 1;
  constructor(mood: Mood = spec.defaults.mood, options: EngineOptions = {}) {
    this.mood = mood;
    this.random = rng(options.seed ?? 1);
    this.reduceMotion = !!options.reduceMotion;
    this.motionProfile = options.motionProfile ?? "default";
    this.nextBlink = 1.5 + this.random() * 2;
  }
  get currentMood() {
    return this.mood;
  }
  setReducedMotion(reduced: boolean) {
    this.reduceMotion = reduced;
    if (reduced) {
      this.hop = { y: 0, v: 0 };
      this.spinLeft = this.angle = this.spawnDebt = 0;
      this.blinkPhase = -1;
      this.particles = [];
      this.nodAge = 1;
      this.attention = this.attentive ? 1 : 0;
    }
  }
  setInteraction({ active, pointer = null }: BotInteraction) {
    if (this.motionProfile !== "list") return;
    if (active && !this.attentive) {
      if (this.canGreet()) this.bounce();
      else this.nodAge = 0;
    }
    this.attentive = active;
    this.look(active ? pointer : null);
    if (this.reduceMotion) this.attention = active ? 1 : 0;
  }
  private canGreet() {
    return this.mood === "idle" || this.mood === "happy" || this.mood === "sleeping";
  }
  private visualMood(): Mood {
    return this.motionProfile === "list" && this.mood === "sleeping" && this.attention > 0.01
      ? "idle" : this.mood;
  }
  setMood(mood: Mood) {
    if (mood === this.mood) return;
    this.mood = mood;
    if (mood === "celebrate") {
      this.bounce();
      this.burst();
    } else if (mood === "happy") this.bounce();
  }
  /** Pointer in unit space (-1..1); null re-centers the eyes. */
  look(pointer: { x: number; y: number } | null) {
    this.pointer = pointer
      ? { x: clamp(pointer.x, -1, 1), y: clamp(pointer.y, -1, 1) }
      : null;
  }
  bounce() {
    if (!this.reduceMotion) this.hop.v = -2.4;
  }
  spin(turns = 1) {
    if (!this.reduceMotion && this.spinLeft <= 0) this.spinLeft = turns;
  }
  burst(count = 26) {
    if (this.reduceMotion) return;
    for (let i = 0; i < count; i++) this.spawn(true);
  }
  private spawn(burst: boolean) {
    if (this.particles.length >= MAX_PARTICLES) return;
    const r = this.random;
    const angle = burst ? -Math.PI / 2 + (r() - 0.5) * Math.PI * 1.4 : 0;
    const speed = burst ? 1.6 + r() * 1.6 : 0;
    const maxLife = 1.2 + r() * 1.2;
    this.particles.push({
      x: burst ? (r() - 0.5) * 0.4 : (r() - 0.5) * 2.4,
      y: burst ? -0.4 : -1.25,
      vx: burst ? Math.cos(angle) * speed : (r() - 0.5) * 0.3,
      vy: burst ? Math.sin(angle) * speed : 0.3 + r() * 0.4,
      rotation: r() * Math.PI * 2,
      spin: (r() - 0.5) * 10,
      life: maxLife,
      maxLife,
      color: Math.floor(r() * spec.confetti.length),
    });
  }
  step(dt: number) {
    dt = clamp(dt, 0, 0.1);
    if (this.motionProfile === "list" && this.reduceMotion) {
      const target = this.gazeTarget();
      this.gaze = { ...target, vx: 0, vy: 0 };
      return;
    }
    this.t += dt;
    this.attention += ((this.attentive ? 1 : 0) - this.attention) * (1 - Math.exp(-12 * dt));
    this.nodAge = Math.min(1, this.nodAge + dt / 0.6);
    const style = spec.moods[this.visualMood()];
    const canBlink = ["open", "focus", "small", "wink"].includes(style.eyes);
    if (!this.reduceMotion && canBlink) {
      this.nextBlink -= dt;
      if (this.nextBlink <= 0 && this.blinkPhase < 0) {
        this.blinkPhase = 0;
        this.nextBlink = 2.4 + this.random() * 3.2;
      }
    }
    if (this.blinkPhase >= 0) {
      this.blinkPhase += dt / BLINK_SECONDS;
      if (this.blinkPhase > 1) this.blinkPhase = -1;
    }
    const target = this.gazeTarget();
    const k = 60,
      d = 12;
    this.gaze.vx += ((target.x - this.gaze.x) * k - this.gaze.vx * d) * dt;
    this.gaze.vy += ((target.y - this.gaze.y) * k - this.gaze.vy * d) * dt;
    this.gaze.x += this.gaze.vx * dt;
    this.gaze.y += this.gaze.vy * dt;
    this.hop.v += (-this.hop.y * 220 - this.hop.v * 14) * dt;
    this.hop.y += this.hop.v * dt;
    if (this.spinLeft > 0) {
      const delta = dt * 1.6;
      this.spinLeft -= delta;
      this.angle += delta * Math.PI * 2;
      if (this.spinLeft <= 0) this.angle = 0;
    }
    if (style.effect === "confetti" && !this.reduceMotion) {
      this.spawnDebt += dt * 14;
      while (this.spawnDebt >= 1) {
        this.spawn(false);
        this.spawnDebt--;
      }
    }
    for (const p of this.particles) {
      p.vy += 2.2 * dt;
      p.vx *= 1 - 0.6 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rotation += p.spin * dt;
      p.life -= dt;
    }
    this.particles = this.particles.filter((p) => p.life > 0 && p.y < 1.6);
  }
  private gazeTarget() {
    const calmList = this.motionProfile === "list" && this.reduceMotion;
    const t = calmList ? 0 : this.t;
    if (this.mood === "searching")
      return { x: Math.sin(t * 2.4) * 0.9, y: 0.1 };
    if (this.mood === "thinking") return { x: 0.55, y: -0.65 };
    if (this.mood === "working") return { x: 0, y: 0.45 };
    if (this.visualMood() === "sleeping") return { x: 0, y: 0 };
    if (calmList) return { x: 0, y: 0 };
    if (this.pointer && (this.motionProfile !== "list" || this.canGreet())) return this.pointer;
    return this.reduceMotion
      ? { x: 0, y: 0 }
      : { x: Math.sin(t * 0.37) * 0.18, y: Math.sin(t * 0.23) * 0.08 };
  }
  frame(): Frame {
    const list = this.motionProfile === "list";
    const t = list && this.reduceMotion ? 0 : this.t,
      mood = this.visualMood();
    const motion = this.reduceMotion ? 0 : 1;
    const breathe = Math.sin((t * Math.PI * 2) / (mood === "sleeping" ? 4 : 3));
    const amp = mood === "sleeping" ? 0.035 : 0.02;
    let offsetY = this.hop.y * (list ? 0.95 : 0.12);
    if (mood === "celebrate") offsetY -= Math.abs(Math.sin(t * 5.5)) * 0.07 * motion;
    else if (mood === "working") offsetY += Math.sin(t * 18) * 0.008 * motion;
    else offsetY += Math.sin(t * 2) * 0.012 * motion;
    const stretch = clamp(-this.hop.v * 0.04, -0.08, 0.1);
    let rotation = this.angle;
    if (list && !this.reduceMotion) {
      if (mood === "thinking") {
        rotation += Math.sin(t * 2.8) * 0.065;
        offsetY += Math.sin(t * 3.2) * 0.035;
      } else if (mood === "searching") {
        rotation += Math.sin(t * 2.4) * 0.09;
        offsetY += Math.sin(t * 4.8) * 0.025;
      } else if (mood === "working") {
        rotation += Math.sin(t * 8) * 0.035;
        offsetY += Math.sin(t * 16) * 0.045;
      }
      const nod = Math.sin(this.nodAge * Math.PI) ** 2;
      offsetY += nod * 0.055;
      rotation += nod * 0.055;
    }
    return {
      t,
      mood,
      blink:
        this.blinkPhase < 0 ? 0 : Math.sin(Math.PI * this.blinkPhase),
      gazeX: clamp(this.gaze.x, -1, 1),
      gazeY: clamp(this.gaze.y, -1, 1),
      scaleX: 1 + (breathe * amp - stretch * 0.6) * motion,
      scaleY: 1 + (-breathe * amp + stretch) * motion,
      offsetY,
      rotation,
      particles: this.particles,
      ...(list ? {
        wave: this.canGreet() ? this.attention * motion : 0,
        armActivity: mood === "working" ? 2.6 : 1,
      } : {}),
    };
  }
}
export function clamp(v: number, min: number, max: number) {
  return v < min ? min : v > max ? max : v;
}
