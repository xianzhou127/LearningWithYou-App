import type { Geometry } from './contract';
import { materialMonitors, displayInGeometry, type DesktopMonitor } from './desktop-layout';
import type { GlassSource } from './glass';

type Feed = { monitor: DesktopMonitor; stream: MediaStream | null; video: HTMLVideoElement; callback: number; frames: number; last: number; fps: number; pending: boolean };
// Requests are serialized because Electron's display callback consumes one grant.
// All connected screens are prepared once. Position changes select existing
// feeds; only topology changes, hiding or disabling material release them.
export class DisplayStreams {
  private feeds = new Map<string, Feed>();
  private chain: Promise<void> = Promise.resolve();
  private disposed = false;
  private selected = new Set<string>();
  private renderingStarted = 0;
  requests = 0;
  constructor(private wake: () => void, private frame: (gap?: number, age?: number) => void, private fail: (message: string) => void) {}
  sync(g: Geometry, fps: number, extra: Geometry[] = []) {
    if (this.disposed) return;
    const wanted = g.desktop?.monitors ?? [];
    this.selected = new Set([g, ...extra].flatMap(value => materialMonitors(value).map(m => m.id)));
    for (const [id, f] of this.feeds) if (!wanted.some(m => m.id === id && (m.profileHash ?? JSON.stringify(m.pixels)) === (f.monitor.profileHash ?? JSON.stringify(f.monitor.pixels)))) { this.feeds.delete(id); this.release(f); }
    for (const monitor of wanted) {
      let feed = this.feeds.get(monitor.id);
      if (feed) {
        if (feed.fps !== fps && feed.stream) { feed.fps = fps; const current = feed; void feed.stream.getVideoTracks()[0].applyConstraints({ frameRate: { ideal: fps, max: fps } }).catch(() => { if (this.feeds.get(monitor.id) === current) this.fail('无法切换采集帧率，请重新开启'); }); }
        continue;
      }
      feed = { monitor, stream: null, video: document.createElement('video'), callback: 0, frames: 0, last: performance.now(), fps, pending: true };
      this.feeds.set(monitor.id, feed);
      const current = feed;
      this.chain = this.chain.then(() => this.open(current)).catch(() => {});
    }
  }
  private current(f: Feed) { return !this.disposed && this.feeds.get(f.monitor.id) === f; }
  private async open(f: Feed) {
    if (!this.current(f)) return;
    let stream: MediaStream | null = null;
    try {
      await window.appearance.prepareCapture(f.monitor.id);
      if (!this.current(f)) return;
      this.requests++; f.last = performance.now();
      stream = await navigator.mediaDevices.getDisplayMedia({ audio: false, video: { frameRate: { ideal: f.fps, max: f.fps }, width: { ideal: f.monitor.physical.width }, height: { ideal: f.monitor.physical.height } } });
      if (!this.current(f)) { stream.getTracks().forEach(t => t.stop()); return; }
      f.stream = stream;
      const track = stream.getVideoTracks()[0]; track.contentHint = 'motion';
      track.addEventListener('ended', () => { if (this.current(f)) this.fail('采集来源已结束，请重新开启'); }, { once: true });
      track.addEventListener('mute', () => { if (this.current(f)) this.fail('采集来源已暂停，请重新开启'); }, { once: true });
      f.video.muted = true; f.video.playsInline = true; f.video.srcObject = stream;
      await f.video.play(); if (!this.current(f)) return;
      f.pending = false; f.last = performance.now(); f.frames = 1; if (this.selected.has(f.monitor.id)) this.frame();
      const next: VideoFrameRequestCallback = (now, metadata) => { if (!this.current(f)) return; const gap = now - f.last; f.last = now; f.frames++; if (this.selected.has(f.monitor.id)) { this.frame(gap, Math.max(0, now - metadata.presentationTime)); this.wake(); } f.callback = f.video.requestVideoFrameCallback(next); };
      f.callback = f.video.requestVideoFrameCallback(next); this.wake();
    } catch (error) { stream?.getTracks().forEach(t => t.stop()); if (this.current(f)) this.fail('显示器采集失败：' + (error instanceof Error ? error.name + ' · ' + error.message.slice(0, 180) : '未知错误')); }
  }
  sources(g: Geometry): GlassSource[] | null {
    const monitors = materialMonitors(g), feeds = monitors.map(m => this.feeds.get(m.id));
    if (!feeds.length || feeds.some(f => !f || f.pending || !f.frames)) return null;
    return feeds.map(f => ({ video: f!.video, display: displayInGeometry(f!.monitor, g), frame: f!.frames }));
  }
  allSources(g: Geometry): GlassSource[] { return [...this.feeds.values()].map(f => ({ video: f.video, display: displayInGeometry(f.monitor, g), frame: f.frames })); }
  get ready() { return this.feeds.size > 0 && [...this.feeds.values()].every(f => !f.pending && f.frames > 0); }
  get prepared() { return [...this.feeds.values()].filter(f => !f.pending && f.frames > 0).length; }
  get tracks() { return [...this.feeds.values()].reduce((n, f) => n + (f.stream?.getTracks().filter(t => t.readyState === 'live').length ?? 0), 0); }
  get bytes() { return [...this.feeds.values()].reduce((n, f) => n + f.video.videoWidth * f.video.videoHeight * 4, 0); }
  get videoStats() { const f = [...this.feeds.values()].find(f => !f.pending); return { videoWidth: f?.video.videoWidth ?? 0, videoHeight: f?.video.videoHeight ?? 0, trackFps: f?.stream?.getVideoTracks()[0]?.getSettings().frameRate ?? null, droppedFrames: [...this.feeds.values()].reduce((n, f) => n + f.video.getVideoPlaybackQuality().droppedVideoFrames, 0) }; }
  // Cold shader/texture preparation can block the renderer while video frame
  // callbacks are queued. Start the steady-state deadline only after prewarm;
  // keep real frame timestamps unchanged and bound bootstrap independently.
  renderingReady(now = performance.now()) { this.renderingStarted = now; }
  healthy(now = performance.now()) { return [...this.feeds.values()].every(f => now - Math.max(f.last, this.renderingStarted) < (f.pending || !this.renderingStarted ? 10000 * this.feeds.size : 2500)); }
  private release(f: Feed) { f.video.cancelVideoFrameCallback(f.callback); f.stream?.getTracks().forEach(t => t.stop()); f.video.pause(); f.video.srcObject = null; }
  stop() { this.disposed = true; for (const f of this.feeds.values()) this.release(f); this.feeds.clear(); }
}
