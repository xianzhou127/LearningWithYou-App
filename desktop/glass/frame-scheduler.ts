// Coalesce video and pointer updates into one browser frame. Input preparation
// runs before the material draw, so both consume the newest local placement.
export class FrameScheduler {
  private handle = 0;
  private running = false;
  private period = 0;
  private due = 0;
  constructor(private render: (now: number) => void, private request: (cb: FrameRequestCallback) => number, private cancel: (id: number) => void) {}
  setLimit(hz: number) { this.period = hz > 0 ? 1000 / hz : 0; this.due = 0; }
  flush(now: number) {
    if (this.running) return;
    if (this.handle) this.cancel(this.handle);
    this.handle = 0; this.running = true;
    try { this.render(now); } finally { this.running = false; }
  }
  schedule() {
    if (this.handle || this.running) return;
    this.handle = this.request(now => {
      this.handle = 0;
      if (this.period && now + 0.25 < this.due) { this.schedule(); return; }
      // Advance the deadline by whole periods, preserving phase. Setting it to
      // now + period every time would turn 144 Hz callbacks into only 48 fps.
      if (this.period) this.due = this.due ? this.due + Math.max(1, Math.floor((now - this.due) / this.period) + 1) * this.period : now + this.period;
      this.running = true;
      try { this.render(now); } finally { this.running = false; }
    });
  }
  stop() { if (this.handle) this.cancel(this.handle); this.handle = 0; this.due = 0; }
}
