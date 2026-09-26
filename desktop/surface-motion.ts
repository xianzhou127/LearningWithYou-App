// Presentation only. One spring per native surface; retargeting keeps velocity.
// No work is scheduled at rest, and no business action waits for this animation.
export type Spring = { value: number; velocity: number };
export function advanceSpring(state: Spring, target: number, elapsed: number): Spring {
  // Analytic damped oscillator: stable even after a delayed/occluded frame.
  const t = Math.min(.1, Math.max(0, elapsed)), omega = 36, damping = .86;
  const decay = damping * omega, frequency = omega * Math.sqrt(1 - damping * damping);
  const displacement = state.value - target;
  const b = (state.velocity + decay * displacement) / frequency;
  const wave = displacement * Math.cos(frequency * t) + b * Math.sin(frequency * t);
  const envelope = Math.exp(-decay * t);
  return { value: target + envelope * wave, velocity: envelope * (-decay * wave + frequency * (b * Math.cos(frequency * t) - displacement * Math.sin(frequency * t))) };
}
type Clock = { now: () => number; schedule: (callback: () => void) => unknown; cancel: (id: unknown) => void };
const clock: Clock = { now: () => performance.now(), schedule: callback => setTimeout(callback, 16), cancel: id => clearTimeout(id as ReturnType<typeof setTimeout>) };
export class SurfaceMotion {
  private state: Spring = { value: 0, velocity: 0 };
  private target = 0;
  private timer: unknown;
  private last = 0;
  constructor(private paint: (progress: number) => void, private hidden: () => void, private time = clock) {}
  set(open: boolean, immediate = false) {
    this.target = open ? 1 : 0;
    if (immediate) { this.stop(); this.state = { value: this.target, velocity: 0 }; this.paint(this.target); if (!open) this.hidden(); return; }
    if (this.timer !== undefined) return;
    this.last = this.time.now();
    this.paint(Math.max(0, Math.min(1, this.state.value)));
    this.timer = this.time.schedule(() => this.tick());
  }
  private tick() {
    this.timer = undefined;
    const now = this.time.now();
    this.state = advanceSpring(this.state, this.target, (now - this.last) / 1000); this.last = now;
    const settled = Math.abs(this.state.value - this.target) < .004 && Math.abs(this.state.velocity) < .06;
    if (settled) this.state = { value: this.target, velocity: 0 };
    this.paint(Math.max(0, Math.min(1, this.state.value)));
    if (settled) { if (!this.target) this.hidden(); }
    else this.timer = this.time.schedule(() => this.tick());
  }
  stop() { if (this.timer !== undefined) this.time.cancel(this.timer); this.timer = undefined; }
}
