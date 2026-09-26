import { FOREGROUND_GROUPS } from './foreground-mask';
import { MotionEngine, REST_POSE, type MotionPose } from './motion';
import { MotionPreview } from './motion-preview';
import { unpull } from './deformation';

// This adapter never dispatches click/Action: React's native button semantics
// and the authoritative DesktopSession remain the only action path.
export class MotionInput {
  readonly engine = new MotionEngine();
  private preview = new MotionPreview(this.engine);
  pose: MotionPose = REST_POSE;
  private pointer: { id: number; node: HTMLButtonElement; index: number; cancelled: boolean } | null = null;
  private suppressClick = false;
  private keyboard: { node: HTMLButtonElement; index: number } | null = null;
  private cleanups: (() => void)[] = [];
  frames = 0;
  peaks = { elevation: 0, gain: 0, stretch: 0, inflation: 0, feedbackScale: 1, feedbackLift: 0, stateLift: 0, pressure: 0, tug: 0, ripple: 0, feedbackRing: 0 };
  constructor(private shell: HTMLElement, private wake: () => void) {
    const local = (distance: number, extent: number, logical: number) => Math.abs(extent / logical - 1) < .0001 ? distance : distance * logical / extent;
    const listen = (target: EventTarget, event: string, fn: (e: Event) => void) => {
      target.addEventListener(event, fn, true); this.cleanups.push(() => target.removeEventListener(event, fn, true));
    };
    const button = (target: EventTarget | null) => {
      const node = target instanceof Element ? target.closest<HTMLButtonElement>('button') : null;
      if (!node || !shell.contains(node) || node.disabled) return null;
      const index = FOREGROUND_GROUPS.findIndex(s => node.matches(s));
      return index < 0 ? null : { node, index };
    };
    const inside = (node: HTMLElement, e: PointerEvent) => { const r = node.getBoundingClientRect(); return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom; };
    listen(shell, 'pointerdown', event => {
      const e = event as PointerEvent, b = button(e.target);
      if (e.button !== 0 || this.pointer || !b) return;
      this.preview.stop(); this.engine.grab(false, performance.now());
      this.suppressClick = false; this.pointer = { ...b, id: e.pointerId, cancelled: false };
      const r = shell.getBoundingClientRect();
      const contact = unpull(local(e.clientX - r.left, r.width, shell.offsetWidth), local(e.clientY - r.top, r.height, shell.offsetHeight), this.pose.contact[0], this.pose.tug, 26 - this.pose.shape[3] - this.pose.elevation * .8);
      this.engine.contactPoint(contact[0], contact[1], performance.now());
      this.engine.press(b.index, true, performance.now()); wake();
    });
    listen(window, 'pointermove', event => {
      const e = event as PointerEvent, p = this.pointer;
      if (!p || p.id !== e.pointerId || p.index === 5) return;
      if (!inside(p.node, e) && !p.cancelled) { p.cancelled = true; this.suppressClick = true; this.engine.press(p.index, false, performance.now()); wake(); }
    });
    listen(window, 'pointerup', event => {
      const e = event as PointerEvent, p = this.pointer;
      if (!p || p.id !== e.pointerId) return;
      this.suppressClick = p.cancelled || !inside(p.node, e);
      this.engine.press(p.index, false, performance.now()); this.pointer = null; wake();
    });
    for (const name of ['pointercancel', 'lostpointercapture']) listen(shell, name, () => { if (this.pointer) this.cancel(); });
    listen(shell, 'click', e => { if ((e as MouseEvent).detail > 0 && this.suppressClick) { e.preventDefault(); e.stopImmediatePropagation(); } });
    listen(shell, 'keydown', event => {
      const e = event as KeyboardEvent, b = button(e.target);
      if (!b || ![' ', 'Enter'].includes(e.key)) return;
      if (e.repeat) { e.preventDefault(); return; }
      this.preview.stop(); this.engine.grab(false, performance.now());
      this.suppressClick = false; this.keyboard = b;
      const shellRect = shell.getBoundingClientRect(), rect = b.node.getBoundingClientRect();
      const contact = unpull(local(rect.x + rect.width / 2 - shellRect.x, shellRect.width, shell.offsetWidth), local(rect.y + rect.height / 2 - shellRect.y, shellRect.height, shell.offsetHeight), this.pose.contact[0], this.pose.tug, 26 - this.pose.shape[3] - this.pose.elevation * .8);
      this.engine.contactPoint(contact[0], contact[1], performance.now());
      this.engine.press(b.index, true, performance.now()); wake();
    });
    listen(shell, 'keyup', event => { if ([' ', 'Enter'].includes((event as KeyboardEvent).key)) this.releaseKey(); });
    listen(shell, 'focusout', () => this.releaseKey());
    listen(window, 'focus', e => { if (e.target === window) { this.engine.setFocus(true, performance.now()); wake(); } });
    listen(window, 'blur', e => { if (e.target === window) { this.cancel(); this.engine.setFocus(false, performance.now()); wake(); } });
    this.engine.setFocus(document.hasFocus(), performance.now());
  }
  request() { this.wake(); }
  previewMotion(action: string) { if (!this.pointer && !this.keyboard) { this.preview.start(action, performance.now()); this.wake(); } }
  private releaseKey() { if (this.keyboard) { this.engine.press(this.keyboard.index, false, performance.now()); this.keyboard = null; this.wake(); } }
  cancel() { this.preview.stop(); this.pointer = null; this.keyboard = null; this.suppressClick = true; this.engine.cancel(performance.now()); this.wake(); }
  sample(now: number) {
    // A Snapshot may disable a held button between pointerdown and pointerup.
    if (this.pointer?.node.disabled || this.keyboard?.node.disabled) this.cancel();
    const previewing = this.preview.step(now);
    const next = this.engine.sample(now); if (previewing) next.active = true;
    const changed = JSON.stringify(next) !== JSON.stringify(this.pose);
    this.pose = next;
    this.peaks.elevation = Math.max(this.peaks.elevation, next.elevation);
    this.peaks.gain = Math.max(this.peaks.gain, next.gain);
    this.peaks.stretch = Math.max(this.peaks.stretch, Math.abs(next.shape[0] - 1), Math.abs(next.shape[1] - 1));
    this.peaks.feedbackScale = Math.max(this.peaks.feedbackScale, next.scales[3]);
    this.peaks.feedbackLift = Math.max(this.peaks.feedbackLift, -next.offsetsY[3]);
    this.peaks.stateLift = Math.max(this.peaks.stateLift, -next.offsetsY[0]);
    this.peaks.pressure = Math.max(this.peaks.pressure, next.contact[2]);
    this.peaks.inflation = Math.max(this.peaks.inflation, next.inflation);
    this.peaks.tug = Math.max(this.peaks.tug, Math.hypot(...next.tug));
    this.peaks.ripple = Math.max(this.peaks.ripple, next.ripple[1]);
    this.peaks.feedbackRing = Math.max(this.peaks.feedbackRing, next.feedbackRing[1]);
    if (changed) {
      this.frames++;
      FOREGROUND_GROUPS.forEach((selector, i) => {
        const node = this.shell.querySelector<HTMLElement>(selector);
        if (node) { node.style.transform = `translate(${next.offsetsX[i]}px, ${next.offsetsY[i]}px) scale(${next.scales[i]})`; node.style.setProperty('--motion-opacity', String(next.opacity[i])); }
      });
    }
    return changed;
  }
  dispose() { this.preview.stop(); this.cleanups.forEach(off => off()); this.engine.reset(); this.engine.visible = false; this.sample(performance.now()); }
}
