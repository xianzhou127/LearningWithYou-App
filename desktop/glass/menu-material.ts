import type { Configuration, Geometry } from './contract';
import { Glass, type GlassSource } from './glass';
import { ForegroundMask } from './foreground-mask';
import { MotionEngine, REST_POSE } from './motion';
import { desktopGeometry } from './desktop-layout';
import { menuPlacementFor, menuGeometry, type MenuPlacement } from './menu-geometry';

// A view of the existing material streams. No capture, IPC grants or session.
export class MenuMaterial {
  private prepared = new Map<number, { key: string; canvas: HTMLCanvasElement; glass: Glass; mask: ForegroundMask }>();
  private selected: number | null = null;
  private get current() { return this.selected === null ? undefined : this.prepared.get(this.selected); }
  private get glass() { return this.current?.glass ?? null; }
  private base: Geometry | null = null;
  private contentHeight = 280;
  private config: Configuration | null = null;
  private enabled = true;
  private created = 0;
  private frost = true;
  open = false;
  private failed = false;
  private engine = new MotionEngine();
  private button: HTMLButtonElement | null = null;
  private contact = [126, 20];
  private configKey = '';
  private frames = 0;
  private listeners: (() => void)[] = [];
  constructor(private shell: HTMLElement, public placement: MenuPlacement, private wake: () => void) {
    const listen = (target: EventTarget, name: string, listener: EventListener) => { target.addEventListener(name, listener); this.listeners.push(() => target.removeEventListener(name, listener)); };
    listen(shell, 'pointerdown', event => {
      const e = event as PointerEvent, target = (e.target as Element).closest('button');
      if (e.button !== 0 || !target || target.disabled) return;
      this.release(); if (this.button) this.button.style.transform = ''; this.button = target;
      const box = shell.getBoundingClientRect(), scale = box.width / shell.offsetWidth;
      this.contact = [(e.clientX - box.x) / scale, (e.clientY - box.y) / scale];
      this.engine.press(4, true, performance.now()); wake();
    });
    listen(window, 'pointerup', () => this.release()); listen(window, 'pointercancel', () => this.release());
    listen(window, 'blur', () => { this.release(); this.engine.cancel(performance.now()); wake(); });
    listen(shell, 'keydown', event => {
      const e = event as KeyboardEvent, target = (e.target as Element).closest('button');
      if (![' ', 'Enter'].includes(e.key) || e.repeat || !target || target.disabled) return;
      this.release(); this.button = target; this.contact = [target.offsetLeft + target.offsetWidth / 2, target.offsetTop + target.offsetHeight / 2];
      this.engine.press(4, true, performance.now()); wake();
    });
    listen(shell, 'keyup', () => this.release());
    listen(shell, 'focusin', () => { this.engine.setFocus(true, performance.now()); wake(); });
    listen(shell, 'focusout', () => { this.release(); this.engine.setFocus(false, performance.now()); wake(); });
  }
  private release() { this.engine.press(4, false, performance.now()); this.wake(); }
  height(value: number) {
    if (!Number.isFinite(value) || value < 100 || value > 2048 || value === this.contentHeight) return;
    this.contentHeight = value; this.stop(); if (this.enabled) this.pending(); if (this.base) this.position(this.base); this.wake();
  }
  position(base: Geometry) {
    this.base = base;
    if (!base.desktop) return;
    this.placement = menuPlacementFor(base, this.contentHeight);
    const { bounds: b, scale } = this.placement, host = base.desktop.host, dpr = devicePixelRatio;
    Object.assign(this.shell.style, { left: `${(b.x - host.x) / dpr}px`, top: `${(b.y - host.y) / dpr}px`, width: `${b.width / scale}px`, height: `${b.height / scale}px`, transform: `scale(${scale / dpr})` });
  }
  configure(c: Configuration) {
    const enabling = !this.enabled && c.enabled && c.visible && c.mode !== 'A';
    this.config = c; this.enabled = c.enabled && c.visible && c.mode !== 'A';
    if (!this.enabled) this.stop();
    else if (enabling) { this.failed = false; this.shell.dataset.material = 'pending'; }
    this.wake();
  }
  pending() { if (this.enabled) this.shell.dataset.material = 'pending'; }
  setOpen(open: boolean) {
    if (this.open === open) return;
    this.open = open; this.shell.dataset.open = String(open);
    // A canvas with inline visibility:visible can paint through a hidden
    // ancestor. Hide the retained buffers on close and until the next live draw.
    for (const entry of this.prepared.values()) entry.canvas.style.visibility = 'hidden';
    if (!open) { this.engine.reset(); if (this.button) this.button.style.transform = ''; this.button = null; }
    else { this.failed = false; if (this.enabled) this.shell.dataset.material = 'pending'; }
    this.wake();
  }
  geometry(base: Geometry) { this.position(base); return menuGeometry(base, this.placement); }
  get animating() { return this.open && (this.engine.sample(performance.now()).active || !!this.glass?.foregroundAnimating); }
  get report() {
    const entries = [...this.prepared.values()];
    return { live: !!this.glass, open: this.open, prepared: entries.length, rendererCreations: this.created, frames: this.frames, failed: this.failed,
      alwaysFrosted: this.frost, effectiveBlurSigma: this.frost ? 6 : this.config?.material.blurSigma ?? null,
      materialRevision: this.glass?.appliedMaterialRevision ?? null, uniforms: this.glass?.uniformReadback ?? null, spatial: this.glass?.spatialSupport ?? null, frost: this.glass?.frostSupport ?? null,
      textureBytesEstimate: entries.reduce((n, { glass }) => n + glass.sourceTextureBytes + glass.roi.width * glass.roi.height * 12 + glass.contentPixels.width * glass.contentPixels.height * 4 + 4 + (glass.spatialSupport?.bytesEstimate ?? 0) + (glass.frostSupport?.bytesEstimate ?? 0), 0),
      outputBufferBytesEstimate: entries.reduce((n, { canvas }) => n + canvas.width * canvas.height * 4, 0) };
  }
  // One cache entry per connected density; movement/open/close do not compile
  // shaders. A genuine content/viewport size change replaces that density only.
  prepare(base: Geometry, sources: (g: Geometry) => GlassSource[], c: Configuration) {
    if (this.failed || !base.desktop) return false;
    let created = false;
    const densities = new Set<number>();
    for (const monitor of base.desktop.monitors) {
      if (densities.has(monitor.scale)) continue; densities.add(monitor.scale);
      const preview = desktopGeometry(base.desktop, { x: monitor.pixels.x + 80 * monitor.scale, y: monitor.pixels.y + 80 * monitor.scale });
      const placement = menuPlacementFor(preview, this.contentHeight), g = menuGeometry(preview, placement)!;
      if (!this.prepared.has(g.scale)) created = this.draw(g, sources(g), c, true) || created;
    }
    this.position(base); return created;
  }
  draw(g: Geometry, sources: GlassSource[], c: Configuration, warming = false): boolean {
    this.config = c; this.frost = c.menuFrost !== false;
    const reduced = c.reduced || matchMedia('(prefers-reduced-motion: reduce)').matches;
    const configKey = JSON.stringify([c.motion, reduced, c.visible]);
    if (configKey !== this.configKey) { this.engine.configure(c.motion, reduced, c.visible, performance.now()); this.configKey = configKey; }
    const pose = this.engine.sample(performance.now());
    if (this.button) this.button.style.transform = `scale(${pose.scales[4]})`;
    const size = { width: g.window.width, height: g.window.height }, key = `${size.width}:${size.height}`;
    if (this.failed) return false;
    let created = false;
    try {
      let entry = this.prepared.get(g.scale);
      if (entry && entry.key !== key) { this.prepared.delete(g.scale); entry.glass.dispose(); entry.mask.dispose(); entry.canvas.remove(); entry = undefined; }
      if (!entry) {
        const canvas = document.createElement('canvas'); canvas.style.visibility = 'hidden'; this.shell.prepend(canvas);
        canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); if (this.prepared.get(g.scale)?.canvas === canvas) this.fail(); });
        const groups = () => Array.from(this.shell.querySelectorAll<HTMLElement>('.menu-content > header > strong, .menu-content > header > button, .menu-content > button, .menu-utilities > button, .menu-content > p, .menu-problem'));
        const mask = new ForegroundMask(this.shell, this.wake, g.scale, size, groups);
        let glass: Glass;
        try { glass = new Glass(canvas, g.scale, tones => { if (this.selected === g.scale) this.shell.style.color = tones?.[0] === 'light' ? '#f6faff' : '#15202f'; }, mask, undefined, { ...size, radius: 16 }); }
        catch (error) { mask.dispose(); canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext(); canvas.remove(); throw error; }
        entry = { key, canvas, glass, mask }; this.prepared.set(g.scale, entry); this.created++;
        glass.setReadingRects([{ x: 16, y: 12, width: size.width - 32, height: 28 }, { x: 12, y: 48, width: size.width - 24, height: Math.max(34, size.height - 120) }, { x: 16, y: size.height - 65, width: size.width - 32, height: 32 }, { x: size.width - 44, y: 12, width: 28, height: 28 }, { x: 16, y: size.height - 30, width: size.width - 32, height: 20 }]);
        created = true;
      }
      if (!warming) { if (this.current) this.current.canvas.style.visibility = 'hidden'; this.selected = g.scale; }
      // The optional menu policy changes blur only. All optics, foreground and
      // accepted press/light physics continue to use the shared configuration.
      const material = this.frost ? { ...c.material, blur: true, blurSigma: 6, adaptiveFrost: false } : c.material;
      entry.glass.draw(sources[0].video, g, true, c.mode, material, c.materialRevision, reduced, true,
        { ...REST_POSE, gain: pose.gain, contact: [this.contact[0], this.contact[1], 0], energy: pose.energy, lightField: pose.lightField, ripple: pose.ripple }, sources, this.frost ? 6 : undefined);
      if (!warming) { this.frames++; entry.canvas.style.visibility = 'visible'; this.shell.dataset.material = 'live'; this.shell.removeAttribute('title'); }
    } catch { this.fail(); }
    return created;
  }
  private fail() { this.stop(); this.failed = true; this.shell.dataset.material = 'failed'; this.shell.title = '菜单材质不可用，已降级；关闭后重新打开可重试'; }
  stop() {
    const entries = [...this.prepared.values()]; this.prepared.clear(); this.selected = null;
    for (const p of entries) { p.glass.dispose(); p.mask.dispose(); p.canvas.remove(); }
    this.engine.reset(); this.configKey = ''; this.failed = false; if (this.button) this.button.style.transform = '';
    this.shell.style.color = '#15202f'; this.shell.dataset.material = 'off';
  }
  dispose() { this.listeners.forEach(off => off()); this.stop(); }
}
