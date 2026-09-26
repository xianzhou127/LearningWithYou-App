export type ElasticState = { value: number; velocity: number; energy: number; active: boolean };

// Unit-mass damped oscillator, solved analytically between force changes.
// Position and velocity survive interruption. This never moves the real window.
export class ElasticMode {
  private x = 0; private v = 0; private at = 0; private until = 0;
  target = 0;
  private omega = 18; private damping = .52;
  private released = false;
  sample(now: number): ElasticState {
    const t = Math.max(0, now - this.at) / 1000;
    if (now >= this.until) { this.x = this.target; this.v = 0; }
    else if (t > 0) {
      const y = this.x - this.target, w = this.omega, z = this.damping;
      const decay = Math.exp(-z * w * t);
      if (z === 1) {
        const b = this.v + w * y;
        this.x = this.target + (y + b * t) * decay;
        this.v = (this.v - w * b * t) * decay;
      } else {
        const wd = w * Math.sqrt(1 - z * z), a = (this.v + z * w * y) / wd;
        const c = Math.cos(wd * t), s = Math.sin(wd * t);
        this.x = this.target + decay * (y * c + a * s);
        this.v = decay * ((-z * w * y + a * wd) * c + (-z * w * a - y * wd) * s);
      }
      // A user can pump a spring by rapidly reversing its force. Dissipative
      // stops bound that energy instead of letting rapid input grow forever.
      if (Math.abs(this.x) > 1.4) { this.x = Math.sign(this.x) * 1.4; if (this.x * this.v > 0) this.v = 0; }
      this.v = Math.max(-32, Math.min(32, this.v));
    }
    this.at = Math.max(this.at, now);
    return { value: this.x, velocity: this.v, energy: .5 * (this.v * this.v + this.omega * this.omega * this.x * this.x), active: now < this.until };
  }
  force(target: number, now: number, duration: number, release = false, damping = .27) {
    this.sample(now);
    if (target === this.target) return;
    this.target = Math.max(-1, Math.min(1, target));
    this.released = release; this.omega = 18 / duration; this.damping = release ? damping : .52;
    this.until = now + (release ? Math.max(1000, 270 / damping) : 800) * duration;
  }
  retune(now: number, duration: number, damping: number) {
    const current = this.sample(now);
    const oldRate = this.omega * this.damping;
    this.omega = 18 / duration;
    if (this.damping !== 1) this.damping = this.released ? damping : .52;
    // Preserve position, velocity and remaining decay, including a cancelled spring.
    if (current.active) this.until = now + (this.until - now) * oldRate / (this.omega * this.damping);
  }
  cancel(now: number, duration: number) {
    if (duration <= 0) { this.reset(); return; }
    this.sample(now); this.target = 0; this.v = 0;
    this.omega = 18 / duration; this.damping = 1; this.until = this.x === 0 ? now : now + 500 * duration;
  }
  reset() { this.x = this.v = this.at = this.until = this.target = 0; }
}
