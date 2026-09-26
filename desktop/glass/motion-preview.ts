import type { MotionEngine } from './motion';

// A visual-only tuning aid. No Action, capture, focus or real anchor access.
export class MotionPreview {
  private turningAt: number | null = null;
  constructor(private engine: MotionEngine) {}
  start(kind: string, now: number) {
    this.stop();
    if (!this.engine.visible || !this.engine.settings.enabled || this.engine.reduced) return;
    if (kind === 'preview-release') { this.engine.grab(false, now); return; }
    this.engine.grab(false, now);
    this.engine.contactPoint(kind === 'preview-center' ? 160 : 18, 26, now);
    this.engine.grab(true, now);
    if (kind === 'preview-turn') this.turningAt = now;
  }
  step(now: number) {
    if (this.turningAt === null) return false;
    if (!this.engine.visible || !this.engine.settings.enabled || this.engine.reduced || !this.engine.settings.liquid || this.engine.settings.stage < 4) { this.stop(); this.engine.cancel(now); return false; }
    const elapsed = now - this.turningAt;
    if (elapsed >= 1100) { this.stop(); this.engine.grab(false, now); return false; }
    this.engine.velocity(650 * Math.cos(elapsed / 180), 260 * Math.sin(elapsed / 180), now);
    return true;
  }
  stop() { this.turningAt = null; }
}
