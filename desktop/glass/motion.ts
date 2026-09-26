import type { Snapshot } from '../shared';
import { ElasticMode } from './elastic';
import { pullOffset } from './deformation';

export const MOTION_CONTROLS = {
  strength: { label: '总强度', min: .5, max: 5, step: .05, unit: '×', initial: 5 },
  duration: { label: '整体时长', min: .75, max: 1.25, step: .05, unit: '×', initial: 1 },
  bulge: { label: '鼓胀半径', min: 0, max: 14, step: .5, unit: 'DIP', initial: 8 },
  pull: { label: '拖拽形变', min: 0, max: 22, step: .5, unit: 'DIP', initial: 12 },
  light: { label: '接触光亮度', min: 0, max: 5, step: .05, unit: '×', initial: 1 },
  waveRadius: { label: '光传播距离', min: 60, max: 360, step: 10, unit: 'DIP', initial: 300 },
  waveWidth: { label: '光波宽度', min: 8, max: 72, step: 2, unit: 'DIP', initial: 28 },
  waveMs: { label: '光传播时长', min: 180, max: 900, step: 20, unit: 'ms', initial: 520 },
  damping: { label: '松手阻尼（越低越弹）', min: .18, max: .8, step: .01, unit: '', initial: .27 },
} as const;
export type MotionNumber = keyof typeof MOTION_CONTROLS;
export type MotionSettings = Record<MotionNumber, number> & { enabled: boolean; liquid: boolean; stage: 1 | 2 | 3 | 4 };
export const DEFAULT_MOTION: MotionSettings = { enabled: true, liquid: true, stage: 4,
  ...Object.fromEntries(Object.entries(MOTION_CONTROLS).map(([key, value]) => [key, value.initial])) as Record<MotionNumber, number> };
export const MAX_MOTION_STRENGTH = 5;
export function patchMotion(old: MotionSettings, value: unknown): MotionSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid motion settings');
  const next = { ...old };
  for (const [key, v] of Object.entries(value)) {
    if ((key === 'enabled' || key === 'liquid') && typeof v === 'boolean') next[key] = v;
    else if (Object.hasOwn(MOTION_CONTROLS, key) && typeof v === 'number' && Number.isFinite(v)) {
      const k = key as MotionNumber, range = MOTION_CONTROLS[k]; next[k] = Math.min(range.max, Math.max(range.min, v));
    }
    else if (key === 'stage' && [1, 2, 3, 4].includes(v as number)) next.stage = v as MotionSettings['stage'];
    else throw new Error('Invalid motion setting: ' + key);
  }
  return next;
}
class Track {
  from = 0; to = 0; start = 0; end = 0;
  smooth = false;
  at(now: number) {
    if (now >= this.end) return this.to;
    const p = Math.max(0, (now - this.start) / (this.end - this.start));
    const progress = this.smooth ? p * p * (3 - 2 * p) : 1 - (1 - p) ** 3;
    return this.from + (this.to - this.from) * progress;
  }
  set(value: number, now: number, duration: number, smooth = false) {
    const current = this.at(now);
    this.from = current; this.to = value; this.start = now; this.smooth = smooth;
    this.end = current === value ? now : now + duration;
  }
  reset() { this.from = this.to = this.start = this.end = 0; }
}
export type MotionPose = {
  shape: [number, number, number, number]; // SDF scale and offset; never a desktop-image transform
  gain: number; localLight: [number, number];
  elevation: number; offsetsX: number[]; offsetsY: number[];
  contact: [number, number, number]; // shell DIP x/y and signed bubble inflation
  energy: number; // bounded elastic + kinetic energy driving internal light
  inflation: number; lightField: [number, number]; // outward DIP; radial width / gain
  ripple: [number, number]; tug: [number, number]; feedbackRing: [number, number];
  scales: number[]; opacity: number[]; active: boolean;
};
export const REST_POSE: MotionPose = { shape: [1, 1, 0, 0], gain: 0, localLight: [0, 0], elevation: 0, energy: 0, inflation: 0, lightField: [28, 0], contact: [18, 26, 0], ripple: [0, 0], tug: [0, 0], feedbackRing: [0, 0], offsetsX: [0, 0, 0, 0, 0, 0], offsetsY: [0, 0, 0, 0, 0, 0], scales: [1, 1, 1, 1, 1, 1], opacity: [1, 1, 1, 1, 1, 1], active: false };

// Pure visual state. It cannot invoke an Action or move the capsule anchor.
// Finite tracks are sampled by the same frame transaction as input and Glass.
export class MotionEngine {
  settings = { ...DEFAULT_MOTION };
  reduced = false; visible = true; focused = false;
  private presses = Array.from({ length: 6 }, () => new Track());
  private focus = new Track(); private lift = new Track();
  private vx = new Track(); private vy = new Track();
  private bubble = new ElasticMode(); private pullX = new ElasticMode(); private pullY = new ElasticMode();
  private held = new Set<number>();
  private contactX = new Track(); private contactY = new Track(); private waveRadius = new Track();
  private waveAt = -Infinity; private waveFrom = 0; private waveSpan = 520;
  private configured = false;
  private tuning = Object.fromEntries(Object.keys(MOTION_CONTROLS).map(key => [key, new Track()])) as Record<MotionNumber, Track>;
  private entering = new Track(); private pulseAt = -Infinity;
  private observed = ''; private seenFeedback = '';
  private dragging = false; private lastVelocity = -Infinity;
  private interactive = true;
  notifications = 0;
  events = { focusIn: 0, focusOut: 0, grab: 0, release: 0, state: 0 };
  constructor() {
    this.contactX.set(18, 0, 0); this.contactY.set(26, 0, 0);
    for (const key of Object.keys(this.tuning) as MotionNumber[]) this.tuning[key].set(this.settings[key], 0, 0);
  }
  contactPoint(x: number, y: number, now: number) {
    if (!this.visible || !this.interactive || !this.settings.enabled || !this.settings.liquid || this.reduced || this.settings.stage < 2) return;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const duration = this.bubble.sample(now).value || this.waveStrength(now) ? this.ms(40) : 0;
    this.contactX.set(Math.max(6, Math.min(315, x)), now, duration, true);
    this.contactY.set(Math.max(8, Math.min(44, y)), now, duration, true);
  }
  private waveStrength(now: number) {
    const p = (now - this.waveAt) / this.waveSpan;
    if (!(p >= 0 && p < 1)) return 0;
    const tail = this.waveFrom * (1 - p * p * (3 - 2 * p));
    const rise = Math.min(1, p * 9);
    return tail + (1 - this.waveFrom) * rise * rise * (3 - 2 * rise) * (1 - p * p * (3 - 2 * p));
  }
  configure(settings: MotionSettings, reduced: boolean, visible: boolean, now: number) {
    const reset = !this.configured || settings.enabled !== this.settings.enabled || settings.liquid !== this.settings.liquid || settings.stage !== this.settings.stage || reduced !== this.reduced || visible !== this.visible;
    const phase = (now - this.waveAt) / this.waveSpan;
    const timingChanged = settings.duration !== this.settings.duration || settings.damping !== this.settings.damping;
    for (const key of Object.keys(this.tuning) as MotionNumber[]) {
      if (reset || settings[key] !== this.settings[key]) this.tuning[key].set(settings[key], now, reset || reduced ? 0 : 80, true);
    }
    this.settings = { ...settings }; this.reduced = reduced; this.visible = visible; this.configured = true;
    if (reset) {
      this.reset();
      if (visible && settings.enabled && this.focused && settings.stage >= 4) this.focus.set(1, now, 0);
    } else {
      if (timingChanged) for (const spring of [this.bubble, this.pullX, this.pullY]) spring.retune(now, settings.duration, settings.damping);
      if (phase >= 0 && phase < 1) {
        this.waveSpan = this.ms(settings.waveMs); this.waveAt = now - phase * this.waveSpan;
        this.waveRadius.set(settings.waveRadius, now, (1 - phase) * this.waveSpan, true);
      }
    }
  }
  private ms(value: number) { return this.reduced || !this.settings.enabled ? 0 : value * this.settings.duration; }
  press(index: number, down: boolean, now: number) {
    if (!this.visible || !this.interactive || !this.settings.enabled) return;
    this.presses[index]?.set(down ? 1 : 0, now, this.ms(down ? 60 : 180));
    if (down) this.held.add(index); else this.held.delete(index);
    if (index !== 5 && this.settings.liquid && !this.reduced && this.settings.stage >= 2) {
      this.bubble.force(this.dragging ? 1 : this.held.size ? .38 : 0, now, this.settings.duration, !down, this.settings.damping);
      if (down) this.emitWave(now);
    }
  }
  setFocus(value: boolean, now: number) {
    if (value !== this.focused) this.events[value ? 'focusIn' : 'focusOut']++;
    this.focused = value;
    if (this.settings.stage >= 4 && this.visible && this.settings.enabled) this.focus.set(value ? 1 : 0, now, this.ms(value ? 140 : 220), true);
  }
  grab(down: boolean, now: number, cancelled = false) {
    if (down === this.dragging) return;
    this.events[down ? 'grab' : 'release']++;
    this.dragging = down;
    if (!this.visible || !this.interactive || !this.settings.enabled || this.settings.stage < 2) return;
    const liquid = this.settings.liquid && !this.reduced;
    this.lift.set(down && !this.reduced && !liquid ? 1 : 0, now, this.ms(down ? 220 : 250), true);
    if (liquid) {
      if (cancelled) this.bubble.cancel(now, this.settings.duration);
      else this.bubble.force(down ? 1 : 0, now, this.settings.duration, !down, this.settings.damping);
      if (down) this.emitWave(now);
    }
    if (!down) {
      this.vx.set(0, now, this.ms(250)); this.vy.set(0, now, this.ms(250));
      for (const spring of [this.pullX, this.pullY]) {
        if (cancelled) spring.cancel(now, this.settings.duration); else spring.force(0, now, this.settings.duration, true, this.settings.damping);
      }
    }
  }
  private emitWave(now: number) {
    const current = this.waveStrength(now);
    if (!current) this.waveRadius.set(0, now, 0);
    this.waveSpan = this.ms(this.settings.waveMs);
    this.waveRadius.set(this.settings.waveRadius, now, this.waveSpan, true);
    this.waveFrom = current; this.waveAt = now;
  }
  velocity(x: number, y: number, now: number) {
    if (!this.dragging || this.reduced || !this.settings.enabled || this.settings.stage < 4) return;
    const speed = Math.hypot(x, y), amount = Math.min(1, Math.max(0, (speed - 60) / 420));
    this.vx.set(speed ? amount * x / speed : 0, now, 45);
    this.vy.set(speed ? amount * y / speed : 0, now, 45);
    if (this.settings.liquid) {
      this.pullX.force(speed ? amount * x / speed : 0, now, this.settings.duration);
      this.pullY.force(speed ? amount * y / speed : 0, now, this.settings.duration);
    }
    this.lastVelocity = now;
  }
  snapshot(s: Pick<Snapshot, 'phase' | 'sessionId' | 'roundId' | 'feedback'>, now: number) {
    const key = `${s.sessionId}:${s.roundId}:${s.phase}`;
    if (key !== this.observed) {
      this.events.state++;
      this.observed = key;
      this.pulseAt = -Infinity;
      if (this.visible && this.interactive && this.settings.enabled && this.settings.stage >= 3 && !this.reduced) {
        if (this.entering.at(now) === 0) this.entering.set(1, now, 0);
        this.entering.set(0, now, this.ms(180), true);
      }
    }
    const id = `${s.sessionId}:${s.roundId}`;
    if (s.phase === 'feedback' && s.feedback && id !== this.seenFeedback) {
      this.seenFeedback = id; // Consume even when hidden/off; never replay on focus/show.
      if (this.visible && this.interactive && this.settings.enabled && this.settings.stage >= 3 && !this.reduced) {
        this.pulseAt = now; this.notifications++;
      }
    }
  }
  cancel(now: number) {
    this.presses.forEach(p => p.set(0, now, this.ms(180))); this.grab(false, now, true);
    // Cancellation discards velocity but retains current shape; no new energy.
    this.held.clear();
    this.waveAt = -Infinity; this.waveRadius.reset();
    for (const spring of [this.bubble, this.pullX, this.pullY]) spring.cancel(now, this.reduced ? 0 : this.settings.duration);
    this.lift.set(0, now, this.ms(250), true);
    this.vx.set(0, now, this.ms(250)); this.vy.set(0, now, this.ms(250));
  }
  availability(value: boolean) { this.interactive = value; if (!value) this.reset(); }
  reset() {
    for (const key of Object.keys(this.tuning) as MotionNumber[]) this.tuning[key].set(this.settings[key], 0, 0);
    [...this.presses, this.focus, this.lift, this.vx, this.vy, this.entering, this.contactX, this.contactY, this.waveRadius].forEach(t => t.reset());
    [this.bubble, this.pullX, this.pullY].forEach(t => t.reset()); this.held.clear();
    this.contactX.set(18, 0, 0); this.contactY.set(26, 0, 0); this.waveAt = -Infinity; this.waveFrom = 0;
    this.dragging = false; this.lastVelocity = this.pulseAt = -Infinity;
  }
  sample(now: number): MotionPose {
    if (!this.visible || !this.settings.enabled) return REST_POSE;
    if (this.dragging && now - this.lastVelocity > 70 && (this.vx.to || this.vy.to)) {
      this.vx.set(0, now, 100); this.vy.set(0, now, 100);
      this.pullX.force(0, now, this.settings.duration, true, this.settings.damping); this.pullY.force(0, now, this.settings.duration, true, this.settings.damping);
    }
    const strength = this.tuning.strength.at(now);
    const liquid = this.settings.liquid && !this.reduced;
    const progress = (now - this.pulseAt) / this.ms(360);
    const pulse = progress >= 0 && progress < 1 ? Math.sin(Math.PI * progress) ** 2 : 0;
    const elastic = [this.bubble, this.pullX, this.pullY].map(spring => spring.sample(now));
    const focus = this.focus.at(now), lift = liquid ? elastic[0].value : this.lift.at(now), enter = this.entering.at(now);
    const x = this.vx.at(now), y = this.vy.at(now), stretch = strength * .01;
    const speed = Math.max(.00001, Math.hypot(x, y));
    const presses = this.presses.map(t => t.at(now));
    const scales = presses.map(p => 1 - .03 * strength * p);
    scales[3] *= 1 + .06 * strength * pulse;
    const opacity = [1 - .45 * enter, 1, 1 - .35 * enter, 1, 1, 1];
    // Lift consumes only the headroom left by focus. A hard sum clamp reached
    // the crest halfway through the track, making the rise feel too abrupt.
    const elevation = this.reduced ? 0 : (.45 * focus + (liquid ? 0 : (1 - .45 * focus) * lift)) * strength;
    // Status and feedback get a small foreground-only lift. Primary position
    // stays fixed; there is no text warping or desktop-image scaling.
    // Keep the expanded 28-DIP feedback group inside the 52-DIP ink viewport.
    const offsetsY = [enter ? -1.5 * strength * enter : 0, 0, 0, pulse ? -Math.min(7, 1.6 * strength) * pulse : 0, 0, 0];
    const pressure = liquid ? elastic[0].value * strength / 5 : 0;
    const energy = liquid ? Math.min(1.5, Math.sqrt(elastic.reduce((sum, s) => sum + s.energy, 0) / (162 / this.settings.duration ** 2))) * strength / 5 : 0;
    const wave = liquid ? this.waveStrength(now) * Math.min(1, energy) : 0;
    const pullLength = Math.max(1, Math.hypot(elastic[1].value, elastic[2].value) / 1.45);
    const pull = this.tuning.pull.at(now) * strength / 5;
    const tug: [number, number] = liquid ? [elastic[1].value ? elastic[1].value * pull / pullLength : 0, elastic[2].value ? -elastic[2].value * .75 * pull / pullLength : 0] : [0, 0];
    // Pulling the left grip outward opens gaps. Pushing it into the contents
    // compresses gently, bounded before neighbouring text/buttons can overlap.
    if (tug[0] > 0) tug[0] = 4 * Math.tanh(tug[0] / 4);
    const contact: [number, number, number] = pressure || energy || wave || tug.some(Boolean) ? [this.contactX.at(now), this.contactY.at(now), pressure] : [18, 26, 0];
    const offsetsX: number[] = [];
    // Fixed 321-DIP LearningToolbar group centres. Glyphs translate rigidly;
    // status and duration share a centre so their relative alignment is stable.
    [87.5, 87.5, 199, 265, 292, 18].forEach((cx, i) => {
      const [dx, dy] = pullOffset(cx, contact[0], tug); offsetsX.push(dx); offsetsY[i] += dy;
    });
    const tracks = [...this.presses, this.focus, this.lift, this.vx, this.vy, this.entering, this.contactX, this.contactY, this.waveRadius, ...Object.values(this.tuning)];
    return { shape: this.reduced || liquid ? [1, 1, 0, 0] : [1 + stretch * (x * x - .3 * y * y) / speed, 1 + stretch * (y * y - .3 * x * x) / speed, x * .18 * strength, y ? -y * .18 * strength : 0],
      gain: (.1 * focus + (.1 - .04 * focus) * lift) * strength,
      localLight: this.reduced ? [0, 0] : [Math.min(.12, presses[2] * .07) * strength, Math.min(.12, pulse * .1) * strength],
      contact, tug, energy, inflation: pressure ? pressure * this.tuning.bulge.at(now) : 0,
      lightField: energy || wave ? [this.tuning.waveWidth.at(now), this.tuning.light.at(now)] : [28, 0],
      ripple: wave ? [this.waveRadius.at(now), wave] : [0, 0],
      feedbackRing: liquid && pulse ? [76 * (1 - progress), .5 * strength / 5 * pulse] : [0, 0],
      elevation, offsetsX, offsetsY, scales, opacity, active: tracks.some(t => now < t.end) || (liquid && elastic.some(s => s.active)) || wave > 0 || pulse > 0 || (Number.isFinite(this.pulseAt) && progress >= 0 && progress < 1) || (this.dragging && (x !== 0 || y !== 0)) };
  }
}
