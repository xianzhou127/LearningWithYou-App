import type { MenuMaterial } from './menu-material';
import { REST_POSE, type MotionPose } from './motion';
import { Glass } from './glass';
import type { InkTone } from './adaptive-ink';
import type { Configuration, Geometry, Telemetry, Rect } from './contract';
import { presentedGeometry, percentile } from './geometry';
import { FrameScheduler } from './frame-scheduler';
import type { MaskSource } from './foreground-mask';
import { DisplayStreams } from './display-streams';
import { desktopGeometry } from './desktop-layout';
export class MaterialCapture {
  private menu: MenuMaterial | null = null;
  setMenu(menu: MenuMaterial | null) { this.menu?.stop(); this.menu = menu; this.requestPresent(); this.report(); }
  private displays: DisplayStreams | null = null;
  private prepared = new Map<number, { canvas: HTMLCanvasElement; glass: Glass }>();
  private warmed = false;
  private captureRequests = 0;
  private rendererCreations = 0;
  private displaySwitches = 0;
  private generation = 0;
  private stream: MediaStream | null = null;
  private starting = false;
  private video = document.createElement('video');
  private glass: Glass | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private raf = 0;
  private frames: FrameScheduler;
  private vfc = 0;
  private watchdog: ReturnType<typeof setInterval> | undefined;
  private lastVideo = 0;
  private lastRender = 0;
  private lastRaf = 0;
  private textureReady = false;
  private geometryRedraws = 0;
  private geometryAges: number[] = [];
  private frameAges: number[] = [];
  private rafGaps: number[] = [];
  private lastDrawn: Geometry | null = null;
  private missed = 0;
  private lastPresented = 0;
  private fresh = false;
  private geometryDirty = false;
  private motionDirty = false;
  motionPose: MotionPose = REST_POSE;
  motionDraws = 0; motionExclusiveDraws = 0; motionSharedDraws = 0;
  motionChanged(pose: MotionPose, changed: boolean) { this.motionPose = pose; this.motionDirty ||= changed; }
  private geometryValue: Geometry | null = null;
  private config: Configuration | null = null;
  private captureFrames = 0;
  private renderFrames = 0;
  private submits: number[] = [];
  private gaps: number[] = [];
  private ages: number[] = [];
  private previousCounts = [0, 0];
  private previousReport = performance.now();
  private status = '采集关闭';
  private reading: Rect[] = [];
  foreground: MaskSource | undefined;
  readingLayout(rects: Rect[]) { this.reading = rects; this.glass?.setReadingRects(rects); for (const p of this.prepared.values()) p.glass.setReadingRects(rects); this.geometryDirty = true; this.requestPresent(); }
  constructor(private host: HTMLElement, private onStatus: (status: string, active: boolean, pending: boolean) => void, private anchorProvider: () => { x: number; y: number } = () => ({ x: 0, y: 0 }), private beforeDraw: (now: number) => void = () => {}, private inputStats: () => Partial<Telemetry> = () => ({}), private onTones: (tones: InkTone[] | null) => void = () => {}) {
    this.frames = new FrameScheduler(now => {
      this.beforeDraw(now);
      if (this.lastRaf) this.push(this.rafGaps, now - this.lastRaf); this.lastRaf = now;
      this.draw(now);
      if (this.motionPose.active) queueMicrotask(() => { if (this.motionPose.active && this.config?.visible) this.requestPresent(); });
    }, cb => requestAnimationFrame(cb), id => cancelAnimationFrame(id));
  }
  requestPresent() { if (this.config?.visible !== false) this.frames.schedule(); }
  flushPresent() { this.frames.flush(performance.now()); }
  positionChanged() { this.geometryDirty = true; this.requestPresent(); }
  geometry(value: Geometry) {
    this.geometryValue = value; this.geometryDirty = true;
    if (value.sentAt) this.push(this.geometryAges, Math.max(0, Date.now() - value.sentAt));
    // Main-process move events are diagnostic/structural input. Actual texture
    // sampling uses the current renderer window origin, independent of IPC delay.
  }
  async configure(config: Configuration) {
    const old = this.config;
    if (config.displays) {
      this.config = config;
      this.frames.setLimit(config.enabled && config.visible && config.mode !== 'A' ? 60 : 0);
      if (!config.enabled || !config.visible || config.mode === 'A') { this.stop(config.visible ? '采集关闭' : '已隐藏 · 采集与渲染已释放'); return; }
      if (old?.displays && JSON.stringify(old.displays) !== JSON.stringify(config.displays)) this.stop('显示器布局更新中…');
      if (!this.displays) {
        this.emit('正在准备所有屏幕背景…', false, true);
        this.displays = new DisplayStreams(() => this.requestPresent(), (gap, age) => { this.captureFrames++; this.lastVideo = performance.now(); this.fresh = true; if (gap !== undefined) this.push(this.gaps, gap); if (age !== undefined) this.push(this.ages, age); }, message => this.stop(message));
        this.watchdog = setInterval(() => { if (this.displays && !this.displays.healthy()) this.stop('超过 2.5 秒未收到新帧，已停止并清除旧画面'); else this.report(); }, 1000);
      }
      this.geometryDirty = true; this.requestPresent(); return;
    }
    if ((this.stream || this.starting) && old && old.enabled === config.enabled && old.mode === config.mode && old.fps === config.fps && old.monitor?.id === config.monitor?.id && old.visible === config.visible) {
      this.config = config;
      if (old.materialRevision !== config.materialRevision || old.reduced !== config.reduced) { this.geometryDirty = true; this.requestPresent(); }
      return;
    }
    this.frames.setLimit(config.enabled && config.visible && config.mode !== 'A' ? Math.min(60, config.monitor?.refreshHz || 60) : 0);
    if (this.stream && old && old.monitor?.id === config.monitor?.id && config.enabled && config.visible && config.mode !== 'A') {
      this.config = config;
      const stream = this.stream, generation = this.generation;
      if (old.fps !== config.fps) await stream.getVideoTracks()[0].applyConstraints({ frameRate: { ideal: config.fps, max: config.fps } }).catch(() => { if (generation === this.generation && this.stream === stream) this.stop('无法切换采集帧率，请重新开启'); });
      if (generation !== this.generation) return;
      this.geometryDirty = true; return;
    }
    this.config = config;
    this.stop(config.visible ? '采集关闭' : '已隐藏 · 采集与渲染已释放');
    if (!config.enabled || config.mode === 'A' || !config.visible || !config.monitor) return;
    if (!this.geometryValue?.valid) { this.emit('胶囊位置无效，请重新选择显示器', false); return; }
    const generation = this.generation;
    this.starting = true;
    this.emit('正在开启真实显示器采集…', false, true);
    let pending: MediaStream | null = null;
    try {
      pending = await navigator.mediaDevices.getDisplayMedia({ audio: false, video: { frameRate: { ideal: config.fps, max: config.fps }, width: { ideal: config.monitor.physical.width }, height: { ideal: config.monitor.physical.height } } });
      if (generation !== this.generation) { pending.getTracks().forEach(t => t.stop()); return; }
      this.stream = pending;
      const track = pending.getVideoTracks()[0]; track.contentHint = 'motion';
      track.addEventListener('ended', () => { if (generation === this.generation) this.stop('采集来源已结束，请重新开启'); }, { once: true });
      track.addEventListener('mute', () => { if (generation === this.generation) this.stop('采集来源已暂停，请重新开启'); }, { once: true });
      this.video.muted = true; this.video.playsInline = true; this.video.srcObject = pending;
      await this.video.play(); if (generation !== this.generation) return;
      this.starting = false;
      const canvas = document.createElement('canvas'); this.canvas = canvas; this.host.append(canvas);
      canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); if (generation === this.generation) this.stop('WebGL 上下文丢失，请重新开启采集'); });
      this.glass = new Glass(canvas, window.devicePixelRatio, this.onTones, this.foreground);
      this.glass.setReadingRects(this.reading);
      this.lastVideo = performance.now(); this.lastRender = 0; this.lastRaf = 0; this.lastPresented = 0; this.textureReady = false;
      const onFrame: VideoFrameRequestCallback = (now, metadata) => {
        if (generation !== this.generation) return;
        if (this.captureFrames) this.push(this.gaps, now - this.lastVideo);
        this.lastVideo = now; this.captureFrames++; this.fresh = true;
        if (this.lastPresented) this.missed += Math.max(0, metadata.presentedFrames - this.lastPresented - 1);
        this.lastPresented = metadata.presentedFrames;
        this.push(this.ages, now - metadata.presentationTime);
        // Coalesce with pointer presentation. No second independent draw and no
        // hand-written FPS gate; the latest video frame wins before one commit.
        this.requestPresent();
        if (generation !== this.generation) return;
        this.vfc = this.video.requestVideoFrameCallback(onFrame);
      };
      const render = () => {
        if (generation !== this.generation) return;
        this.raf = requestAnimationFrame(render);
        this.requestPresent();
      };
      this.vfc = this.video.requestVideoFrameCallback(onFrame);
      // Only the old native-window diagnostic needs continuous origin polling.
      // The fixed host wakes for video frames, input or configuration changes.
      if (!config.fixedHost) this.raf = requestAnimationFrame(render);
      this.watchdog = setInterval(() => {
        if (performance.now() - this.lastVideo > 1500) this.stop('超过 1.5 秒未收到新帧，已停止并清除旧画面');
        else this.report();
      }, 1000);
    } catch (error) {
      pending?.getTracks().forEach(t => t.stop());
      if (generation === this.generation) this.stop('采集或 WebGL 启动失败：' + (error instanceof Error ? error.name + ' · ' + error.message.slice(0, 220) : 'unknown'));
    }
  }
  private draw(now: number) {
    if (!this.geometryValue || !this.config) return;
    const structure = this.geometryValue;
    const anchor = structure.fixedHost ? this.anchorProvider() : { x: 0, y: 0 };
    const outerX = structure.fixedHost ? structure.window.x - (structure.clientOffset?.x ?? 0) : window.screenX;
    const outerY = structure.fixedHost ? structure.window.y - (structure.clientOffset?.y ?? 0) : window.screenY;
    const g = structure.desktop ? desktopGeometry(structure.desktop, anchor) : presentedGeometry(structure, anchor, outerX, outerY);
    const menuGeometry = this.menu?.geometry(g);
    let sources: ReturnType<DisplayStreams['sources']> = null;
    try { if (this.displays) {
      this.displays.sync(g, this.config.fps, this.menu?.open && menuGeometry ? [menuGeometry] : []); sources = this.displays.sources(g);
      if (!this.displays.ready || !sources) {
        if (this.canvas) this.canvas.style.visibility = 'hidden'; this.foreground?.visible(false);
        this.emit('正在准备所有屏幕背景…', false, true); return;
      }
      const monitors = g.desktop!.monitors;
      const densities = [...new Set(monitors.map(m => m.scale))];
      this.foreground?.prepareDensities?.(densities);
      if (!this.warmed) {
        for (const monitor of monitors) {
          if (this.prepared.has(monitor.scale)) continue;
          const canvas = document.createElement('canvas'); canvas.style.visibility = 'hidden'; this.host.append(canvas);
          canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); if (this.prepared.get(monitor.scale)?.canvas === canvas) this.stop('WebGL 上下文丢失，请重新开启'); });
          let glass: Glass;
          try { glass = new Glass(canvas, monitor.scale, tones => { if (this.glass === this.prepared.get(monitor.scale)?.glass) this.onTones(tones); }, this.foreground, monitor.adaptation); }
          catch (error) { canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext(); canvas.remove(); throw error; }
          this.prepared.set(monitor.scale, { canvas, glass }); this.rendererCreations++;
          glass.setReadingRects(this.reading); this.foreground?.density?.(monitor.scale);
          const preview = desktopGeometry(g.desktop!, { x: monitor.pixels.x + 80 * monitor.scale, y: monitor.pixels.y + 80 * monitor.scale });
          const all = this.displays.allSources(preview);
          glass.draw(all[0].video, preview, true, this.config.mode, this.config.material, this.config.materialRevision, this.config.reduced, true, this.motionPose, all);
        }
        this.warmed = true;
        this.displays.renderingReady();
      }
      if (this.menu?.prepare(g, preview => this.displays!.allSources(preview), this.config)) this.displays.renderingReady();
      const selected = this.prepared.get(g.scale)!;
      if (this.glass !== selected.glass || this.lastDrawn?.activeMonitor !== g.activeMonitor) {
        if (this.canvas) this.canvas.style.visibility = 'hidden';
        this.canvas = selected.canvas; this.glass = selected.glass;
        if (this.lastDrawn) this.displaySwitches++;
        this.fresh = true; this.geometryDirty = true;
      }
      this.foreground?.density?.(g.scale);
      this.canvas!.style.visibility = 'visible';
    } } catch { this.stop('材质启动失败，请重新开启；旧画面已清除'); return; }
    if (this.menu?.open && menuGeometry && this.displays?.ready) {
      const menuSources = this.displays.sources(menuGeometry);
      if (menuSources && this.menu.draw(menuGeometry, menuSources, this.config)) this.displays.renderingReady();
      if (this.menu.animating) queueMicrotask(() => { if (this.menu?.animating && this.config?.visible) this.requestPresent(); });
    }
    if (!this.glass || (!this.fresh && !this.textureReady)) return;
    if (!g.valid) { this.stop('胶囊已离开所选显示器，请移回并重新开启'); return; }
    const moved = this.lastDrawn?.window.x !== g.window.x || this.lastDrawn?.window.y !== g.window.y;
    const baselineReason = this.fresh || moved || this.geometryDirty || this.glass.backgroundAnimating;
    const motionReason = this.motionDirty || this.motionPose.active;
    if (!baselineReason && !motionReason && !this.glass.foregroundAnimating) return;
    try {
      const upload = this.fresh;
      this.push(this.submits, this.glass.draw(sources?.[0].video ?? this.video, g, upload, this.config.mode, this.config.material, this.config.materialRevision, this.config.reduced || matchMedia('(prefers-reduced-motion: reduce)').matches, upload || moved || this.geometryDirty, this.motionPose, sources ?? undefined));
      if (motionReason) { this.motionDraws++; if (baselineReason) this.motionSharedDraws++; else this.motionExclusiveDraws++; }
      this.motionDirty = false;
      if (moved && !upload) this.geometryRedraws++;
      this.push(this.frameAges, Math.max(0, now - this.lastVideo));
      this.textureReady = true; this.lastDrawn = g;
      this.fresh = false; this.geometryDirty = false; this.lastRender = now; this.renderFrames++;
      const debug = this.config.mode === 'C' && this.config.material.debugView !== 'normal';
      const text = `${this.config.mode} · ${debug ? '诊断视图，不用于背景验收' : this.displays ? '自动适配屏幕' : '实时外部画面'} · 采集 ${this.config.fps} fps 目标`;
      if (this.status !== text) this.emit(text, true);
      // FrameScheduler deliberately coalesces calls made inside a draw. Queue
      // the next presentation after it releases its running flag.
      if (this.glass.foregroundAnimating) queueMicrotask(() => { if (this.glass?.foregroundAnimating) this.requestPresent(); });
    } catch { this.stop('材质渲染失败，请重新开启；旧画面已清除'); }
  }
  private push(target: number[], n: number) { target.push(n); if (target.length > 120) target.shift(); }
  private emit(status: string, active: boolean, pending = false) { this.status = status; if (pending) this.menu?.pending(); this.onStatus(status, active, pending); }
  report() {
    const now = performance.now(), seconds = Math.max((now - this.previousReport) / 1000, .001);
    const live = !!this.stream || !!this.displays;
    const v: Telemetry = { menu: this.menu?.report ?? null, status: this.status, liveTracks: this.displays?.tracks ?? this.stream?.getTracks().filter(t => t.readyState === 'live').length ?? 0,
      captureFrames: this.captureFrames, renderFrames: this.renderFrames, captureHz: live ? (this.captureFrames - this.previousCounts[0]) / seconds : 0, renderHz: live ? (this.renderFrames - this.previousCounts[1]) / seconds : 0,
      submitMsP50: percentile(this.submits, .5), submitMsP95: percentile(this.submits, .95), gpuMsP95: this.glass?.gpuTimes.length ? percentile(this.glass.gpuTimes, .95) : null,
      frameGapMsP95: percentile(this.gaps, .95), maxFrameGapMs: Math.max(0, ...this.gaps), callbackAgeMsP95: percentile(this.ages, .95),
      videoWidth: this.video.videoWidth, videoHeight: this.video.videoHeight, trackFps: this.stream?.getVideoTracks()[0]?.getSettings().frameRate ?? null,
      droppedFrames: this.video.getVideoPlaybackQuality().droppedVideoFrames, mapping: this.geometryValue ? { ...this.geometryValue, desktop: undefined } : null,
      gl: this.glass?.renderer ?? 'released', textureBytesEstimate: this.glass ? (this.displays?.bytes ?? this.video.videoWidth * this.video.videoHeight * 4) + this.glass.roi.width * this.glass.roi.height * 4 * 3 + this.glass.contentPixels.width * this.glass.contentPixels.height * 4 + 4 : 0 };
    // One RGBA8 presentation buffer estimate, separate from owned textures.
    // Chromium / driver may allocate multiple buffers; this is not GPU memory.
    v.outputPixels = this.canvas ? [this.canvas.width, this.canvas.height] : [0, 0];
    v.outputBufferBytesEstimate = this.canvas ? this.canvas.width * this.canvas.height * 4 : 0;
    v.geometryDeliveryMsP95 = percentile(this.geometryAges, .95); v.geometryRedraws = this.geometryRedraws;
    v.frameAgeAtDrawMsP95 = percentile(this.frameAges, .95); v.localWindowPosition = this.lastDrawn?.window;
    v.videoCallbacksMissed = this.missed; v.rafGapMsP95 = percentile(this.rafGaps, .95);
    v.renderTargetHz = live ? Math.min(60, this.config?.monitor?.refreshHz || 60) : 0;
    v.videoUploadMsP95 = this.glass?.uploadTimes.length ? percentile(this.glass.uploadTimes, .95) : null;
    v.materialBranch = this.glass?.materialBranch ?? null;
    v.appliedMaterialRevision = this.glass?.appliedMaterialRevision ?? null;
    v.materialUniforms = this.glass?.uniformReadback ?? null;
    v.lighting = this.glass?.lighting ?? null;
    v.readingSupport = this.glass?.readingSupport ?? null;
    v.spatialSupport = this.glass?.spatialSupport ?? null;
    v.frostSupport = this.glass?.frostSupport ?? null;
    v.textureBytesEstimate += this.glass?.frostSupport?.bytesEstimate ?? 0;
    v.textureBytesEstimate += this.glass?.spatialSupport?.bytesEstimate ?? 0;
    if (this.displays) Object.assign(v, this.displays.videoStats);
    v.preparedDisplays = this.displays?.prepared ?? 0; v.preparedRenderers = this.prepared.size;
    v.captureRequests = this.captureRequests + (this.displays?.requests ?? 0); v.rendererCreations = this.rendererCreations; v.displaySwitches = this.displaySwitches;
    if (this.prepared.size) {
      v.textureBytesEstimate = [...this.prepared.values()].reduce((n, { glass }) => n + glass.sourceTextureBytes + glass.roi.width * glass.roi.height * 12 + glass.contentPixels.width * glass.contentPixels.height * 4 + 4 + (glass.frostSupport?.bytesEstimate ?? 0) + (glass.spatialSupport?.bytesEstimate ?? 0), 0);
      v.outputBufferBytesEstimate = [...this.prepared.values()].reduce((n, { canvas }) => n + canvas.width * canvas.height * 4, 0);
    }
    v.textureBytesEstimate += this.menu?.report.textureBytesEstimate ?? 0;
    v.outputBufferBytesEstimate += this.menu?.report.outputBufferBytesEstimate ?? 0;
    Object.assign(v, this.inputStats());
    if (v.motion) v.motion.pose = this.glass?.motionApplied ?? null;
    this.previousReport = now; this.previousCounts = [this.captureFrames, this.renderFrames]; window.appearance.report(v);
  }
  loseContext() { this.glass?.loseContext(); }
  stop(status = '采集关闭') {
    this.menu?.stop();
    this.captureRequests += this.displays?.requests ?? 0; this.displays?.stop(); this.displays = null;
    this.starting = false;
    this.motionPose = REST_POSE; this.motionDirty = false;
    this.generation++; cancelAnimationFrame(this.raf); this.frames.stop(); this.video.cancelVideoFrameCallback(this.vfc);
    if (this.watchdog) clearInterval(this.watchdog); this.watchdog = undefined;
    this.stream?.getTracks().forEach(t => t.stop()); this.stream = null;
    this.video.pause(); this.video.srcObject = null;
    const prepared = [...this.prepared.values()]; this.prepared.clear(); this.warmed = false;
    if (prepared.length) for (const p of prepared) { p.glass.dispose(); p.canvas.remove(); }
    else if (this.glass) this.glass.dispose();
    else this.canvas?.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext();
    this.glass = null; this.canvas?.remove(); this.canvas = null;
    this.foreground?.visible(false);
    this.onTones(null);
    this.fresh = false; this.geometryDirty = false; this.textureReady = false; this.lastDrawn = null;
    this.submits = []; this.gaps = []; this.ages = [];
    this.emit(status, false); this.frames.stop(); this.report();
  }
}
