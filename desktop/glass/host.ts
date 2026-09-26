import { roundedMenuHit, type MenuPlacement } from './menu-geometry';
import { app, BrowserWindow, dialog, ipcMain, Menu, screen, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import { AppearanceStore } from './settings-store';
import { SIZE, type Geometry, type Monitor, type Telemetry } from './contract';
import { capsuleDistance } from './geometry';
import { constrainDesktop, desktopGeometry, union, type DesktopMonitor, type SamplingProfiles } from './desktop-layout';
import { patchMaterial } from './material-settings';
import { patchMotion } from './motion';
import { allowCapturePermission } from './permission';
import type { AppearanceKind, AppearanceState, PreviewAction } from './api';
import type { Role, Snapshot } from '../shared';
import { readNativeCatalog, type NativeMonitor } from '../sources';
import { DisplayCache } from './display-cache';
import type { DisplayIdentity } from './display-adaptation';

type Event = IpcMainEvent | IpcMainInvokeEvent;
const previewActions: PreviewAction[] = ['preview-grip', 'preview-center', 'preview-turn', 'preview-release'];
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export class AppearanceHost {
  readonly store: AppearanceStore;
  private state: AppearanceState;
  private anchor = { x: 0, y: 0 };
  private captureGrant: string | null = null;
  private sequence = 0;
  private generation = 0;
  private dragging = false;
  private ignored = true;
  private latest: Telemetry | null = null;
  private consumedFeedback = '';
  private nativeMonitors: NativeMonitor[] = [];
  private sourceIds = new Map<string, string>();
  private sampling: SamplingProfiles = {};
  private displayRefresh: Promise<void> = Promise.resolve();
  private layoutRevision = 0;
  private disposed = false;
  dispose() { this.disposed = true; this.generation++; this.layoutRevision++; this.captureGrant = null; this.dragging = false; }
  constructor(private windows: Map<Role, BrowserWindow>, private auth: (event: Event, roles: Role[]) => Role,
    private openTuner: () => BrowserWindow, private aligned: () => void, private snapshot: () => Snapshot) {
    this.store = new AppearanceStore(path.join(app.getPath('userData'), 'appearance-v1'));
    this.state = { mode: 'C', fps: 30, monitor: null, enabled: true, startupEnabled: true, reduced: false, visible: false, fixedHost: true,
      material: this.store.material.settings, motion: this.store.motion.settings, materialRevision: 0, revision: 0, failure: null, saved: this.store.summary() };
  }
  async load() { await this.store.load(); await this.prepareDisplays(); this.syncStore(); this.state.enabled = this.state.startupEnabled !== false; }
  private async prepareDisplays(revision = this.layoutRevision) {
    this.nativeMonitors = await readNativeCatalog().then(c => c.monitors).catch(() => []);
    const inventory = screen.getAllDisplays(), monitors = inventory.map(d => this.monitorFor(d));
    const inputs: DisplayIdentity[] = inventory.map((d, i) => ({ id: monitors[i].id, device: this.nativeMonitors.find(n => screen.getDisplayMatching(screen.screenToDipRect(null, n)).id === d.id)?.device ?? '', label: d.label || '', bounds: d.bounds, pixels: monitors[i].pixels, scale: d.scaleFactor, rotation: d.rotation, refreshHz: d.displayFrequency, colorDepth: d.colorDepth, depthPerComponent: d.depthPerComponent, colorSpace: d.colorSpace, internal: d.internal }));
    const cached = await new DisplayCache(path.join(this.store.directory, 'display-adaptation-v1.json')).resolve(inputs);
    if (this.disposed || revision !== this.layoutRevision) return;
    this.state.displays = monitors.map(m => { const entry = cached.entries.find(e => e.input.id === m.id)!; return { ...m, adaptation: entry.adaptation, profileHash: entry.hash }; });
    this.state.displayCache = cached.status;
    this.sampling = cached.sampling;
    this.sourceIds = new Map(this.nativeMonitors.map(m => [String(screen.getDisplayMatching(screen.screenToDipRect(null, m)).id), m.id]));
  }
  private syncStore() {
    this.state = { ...this.state, material: this.store.material.settings, motion: this.store.motion.settings,
      fps: this.store.material.fps, startupEnabled: this.store.material.startupEnabled !== false, menuFrost: this.store.material.menuFrost !== false, reduced: this.store.motion.reduced, saved: this.store.summary() };
  }
  config() { return this.state; }
  telemetry() { return this.latest; }
  private orb() { return this.windows.get('orb')!; }
  private send(channel: string, value: unknown) {
    if (this.disposed) return;
    for (const role of ['orb', 'appearance'] as const) { const w = this.windows.get(role); if (w && !w.isDestroyed() && !w.webContents.isDestroyed()) w.webContents.send(channel, value); }
  }
  private publish() { this.syncStore(); this.state = { ...this.state, revision: this.state.revision + 1 }; this.send('appearance:config', this.state); }
  geometry(): Geometry {
    const host = screen.dipToScreenRect(this.orb(), this.orb().getContentBounds());
    return { ...desktopGeometry({ host, position: this.anchor, monitors: this.state.displays!, sampling: this.sampling }), sentAt: Date.now(), sequence: ++this.sequence };
  }
  visibleBounds() { const g = this.geometry(), s = g.scale; return screen.screenToDipRect(null, { x: Math.round(this.anchor.x + SIZE.inset * s), y: Math.round(this.anchor.y + SIZE.inset * s), width: Math.round(SIZE.capsuleWidth * s), height: Math.round(SIZE.capsuleHeight * s) }); }
  private geometryChanged() { if (this.disposed || !this.orb() || this.orb().isDestroyed()) return; this.send('appearance:geometry', this.geometry()); this.aligned(); }
  private place(initial = false) {
    const displays = this.state.displays!;
    const primary = displays.find(d => d.id === String(screen.getPrimaryDisplay().id)) ?? displays[0];
    this.state.displays = displays;
    if (initial) this.anchor = { x: Math.round(primary.pixels.x + (primary.pixels.width - SIZE.width * primary.scale) / 2), y: primary.pixels.y + 90 * primary.scale };
    this.anchor = constrainDesktop(this.anchor, displays);
    this.orb().setBounds(screen.screenToDipRect(this.orb(), union(displays.map(d => d.pixels))), false);
    const g = this.geometry(); this.state.monitor = displays.find(d => d.id === g.activeMonitor)!;
    this.geometryChanged();
  }
  attach() {
    const orb = this.orb();
    this.place(true);
    orb.setIgnoreMouseEvents(true, { forward: true });
    orb.on('blur', () => { this.dragging = false; this.hit(); });
    orb.on('hide', () => this.visible(false));
    orb.on('show', () => this.visible(true));
    orb.webContents.on('did-finish-load', () => { this.geometryChanged(); this.publish(); });
    orb.webContents.on('render-process-gone', () => { this.generation++; this.state.enabled = false; this.dragging = false; this.publish(); });
    const resetDisplay = () => {
      this.generation++; this.captureGrant = null; this.dragging = false;
      const revision = ++this.layoutRevision;
      this.sourceIds.clear();
      this.displayRefresh = this.displayRefresh.then(async () => {
        if (revision !== this.layoutRevision || this.disposed || orb.isDestroyed()) return;
        await this.prepareDisplays(revision);
        if (revision !== this.layoutRevision || this.disposed || orb.isDestroyed()) return;
        this.state = { ...this.state, enabled: this.state.enabled || !!this.state.failure, failure: null };
        this.place(); this.publish(); this.hit();
      }).catch(() => { if (!this.disposed) { this.state.enabled = false; this.state.failure = '屏幕配置检查失败，请重新开启材质'; this.publish(); } });
    };
    screen.on('display-added', resetDisplay); screen.on('display-removed', resetDisplay); screen.on('display-metrics-changed', resetDisplay);
    orb.once('closed', () => { this.dispose(); screen.removeListener('display-added', resetDisplay); screen.removeListener('display-removed', resetDisplay); screen.removeListener('display-metrics-changed', resetDisplay); });
  }
  visible(visible: boolean) {
    if (this.disposed || !this.orb() || this.orb().isDestroyed() || visible === this.state.visible) return;
    this.generation++; this.captureGrant = null; this.dragging = false; this.state = { ...this.state, visible };
    if (!visible) { this.ignored = true; this.orb().setIgnoreMouseEvents(true, { forward: true }); }
    this.geometryChanged(); this.publish(); if (visible) this.hit();
  }
  move(dx: number, dy: number) { const scale = this.geometry().scale; this.anchor = constrainDesktop({ x: this.anchor.x + dx * scale, y: this.anchor.y + dy * scale }, this.state.displays!); this.geometryChanged(); this.hit(); }
  private menu: MenuPlacement | null = null;
  menuBounds(value: MenuPlacement | null) { this.menu = value; this.hit(); }
  private hit(inside?: boolean) {
    if (this.disposed || !this.orb() || this.orb().isDestroyed() || !this.state.visible || this.dragging) return;
    const p = screen.dipToScreenPoint(screen.getCursorScreenPoint()), scale = this.geometry().scale;
    const outside = inside === undefined ? !(capsuleDistance((p.x - this.anchor.x) / scale, (p.y - this.anchor.y) / scale) <= 0 || (this.menu && roundedMenuHit(p.x, p.y, this.menu.bounds, 16 * this.menu.scale))) : !inside;
    if (outside !== this.ignored) { this.ignored = outside; this.orb().setIgnoreMouseEvents(outside, { forward: true }); }
  }
  private monitorFor(d: Electron.Display): DesktopMonitor {
    const native = this.nativeMonitors.find(m => screen.getDisplayMatching(screen.screenToDipRect(null, m)).id === d.id);
    const pixels = native ? { x: native.x, y: native.y, width: native.width, height: native.height } : screen.dipToScreenRect(null, d.bounds);
    return { id: String(d.id), name: `${d.label || '显示器'} · ${d.size.width}×${d.size.height} DIP · ${Math.round(d.scaleFactor * 100)}%`,
      bounds: d.bounds, pixels, workAreaPixels: screen.dipToScreenRect(null, d.workArea), scale: d.scaleFactor, refreshHz: d.displayFrequency, physical: { width: pixels.width, height: pixels.height } };
  }
  async monitors(): Promise<Monitor[]> {
    return this.state.displays ?? [];
  }
  isOrb(contents: Electron.WebContents | null) { const orb = this.windows.get('orb'); return !this.disposed && !!contents && !!orb && !orb.isDestroyed() && contents === orb.webContents; }
  private allowed() {
    const orb = this.orb();
    // This host contains both glass surfaces and is always excluded from capture.
    // The user preference controls other windows only; deny an unprotected host
    // rather than feeding the capsule/menu back into their own material.
    return !this.disposed && !!orb && !orb.isDestroyed() && !orb.webContents.isDestroyed()
      && this.state.enabled && this.state.mode !== 'A' && this.state.visible && orb.isVisible() && !!this.state.monitor && orb.isContentProtected();
  }
  permission(contents: Electron.WebContents | null, permission: string, types?: string[]) { return allowCapturePermission(this.isOrb(contents), this.allowed(), permission, types); }
  async displayRequest(request: Electron.DisplayMediaRequestHandlerHandlerRequest, callback: (streams: Electron.Streams) => void) {
    const generation = this.generation, selected = this.captureGrant; this.captureGrant = null;
    let streams: Electron.Streams = {};
    try {
      if (selected && this.allowed() && request.frame === this.orb().webContents.mainFrame && request.videoRequested && !request.audioRequested && ['learning://app', 'learning://app/'].includes(request.securityOrigin)) {
        // Reuse the formal document picker's native monitor IDs. Electron's
        // thumbnail enumerator can omit monitors on hybrid-GPU Windows systems.
        // This reads metadata only; no thumbnails, audio or learning source grant.
        const id = this.sourceIds.get(selected);
        if (id && generation === this.generation && this.allowed() && screen.getAllDisplays().some(d => String(d.id) === selected)) streams = { video: { id, name: '本地材质背景' } };
      }
    } catch { /* Deny unavailable monitors while leaving learning media alone. */ }
    try { callback(streams); } catch { /* Electron rejects an empty grant; never call a consumed callback twice. */ }
  }
  install() {
    const handle = (name: string, fn: (arg: unknown) => unknown, roles: Role[] = ['appearance']) => ipcMain.handle(`appearance:${name}`, (event, arg) => { this.auth(event, roles); return fn(arg); });
    handle('config', () => this.state, ['orb', 'appearance']);
    handle('geometry', () => this.geometry(), ['orb']);
    handle('monitors', () => this.monitors()); handle('telemetry', () => this.latest);
    handle('prepare-capture', value => {
      if (!this.allowed()) throw new Error('Material capture unavailable');
      if (typeof value !== 'string' || !this.state.displays?.some(d => d.id === value)) throw new Error('Invalid material display');
      this.captureGrant = value;
    }, ['orb']);
    handle('tune', patch => { this.store.material = { ...this.store.material, settings: patchMaterial(this.store.material.settings, patch) }; this.state.materialRevision++; this.publish(); return this.state; });
    handle('configure', async value => {
      if (!object(value) || Object.keys(value).some(k => !['mode', 'fps', 'startupEnabled', 'menuFrost', 'enabled', 'reduced', 'motion'].includes(k))) throw new Error('Invalid appearance change');
      if (value.menuFrost !== undefined && typeof value.menuFrost !== 'boolean' || value.startupEnabled !== undefined && typeof value.startupEnabled !== 'boolean' || value.enabled !== undefined && typeof value.enabled !== 'boolean' || value.reduced !== undefined && typeof value.reduced !== 'boolean' || value.fps !== undefined && ![30, 60].includes(value.fps as number) || value.mode !== undefined && !['A', 'B', 'C'].includes(value.mode as string)) throw new Error('Invalid appearance value');
      const motion = value.motion === undefined ? null : patchMotion(this.store.motion.settings, value.motion);
      if (typeof value.menuFrost === 'boolean') this.store.material = { ...this.store.material, menuFrost: value.menuFrost };
      if (typeof value.startupEnabled === 'boolean') this.store.material = { ...this.store.material, startupEnabled: value.startupEnabled };
      if (motion) this.store.motion = { ...this.store.motion, settings: motion };
      if (typeof value.reduced === 'boolean') this.store.motion = { ...this.store.motion, reduced: value.reduced };
      if (value.fps === 30 || value.fps === 60) this.store.material = { ...this.store.material, fps: value.fps };
      if (value.mode === 'A' || value.mode === 'B' || value.mode === 'C') { this.state.mode = value.mode; this.generation++; }
      if (value.enabled === false) { this.state.enabled = false; this.state.failure = null; this.generation++; this.captureGrant = null; }
      if (value.enabled === true) { this.state.enabled = true; this.state.failure = null; }
      this.publish(); return this.state;
    });
    for (const kind of ['material', 'motion'] as const) handle(`save-${kind}`, async () => { try { return await this.store.save(kind); } finally { this.publish(); } });
    handle('import', async value => {
      if (value !== 'material' && value !== 'motion') throw new Error('Invalid settings kind');
      const result = await dialog.showOpenDialog(this.windows.get('appearance')!, { title: `只读导入${value === 'material' ? '材质' : '动效'}参数到预览`, properties: ['openFile'], filters: [{ name: '参数 JSON', extensions: ['json'] }] });
      if (!result.canceled && result.filePaths[0]) { await this.store.importFile(value as AppearanceKind, result.filePaths[0]); this.state.materialRevision++; this.publish(); }
    });
    handle('utility', action => {
      if (!previewActions.includes(action as PreviewAction)) throw new Error('Invalid preview');
      if (action === 'preview-release' || this.allowed()) this.orb().webContents.send('appearance:diagnostic', action);
    });
    handle('consume-feedback', value => {
      const s = this.snapshot();
      if (!object(value) || s.phase !== 'feedback' || !s.feedback || s.sessionId !== value.sessionId || s.roundId !== value.roundId) return false;
      const key = `${s.sessionId}:${s.roundId}`;
      if (key === this.consumedFeedback) return false;
      this.consumedFeedback = key; return true;
    }, ['orb']);
    ipcMain.on('appearance:context-menu', event => {
      try { this.auth(event, ['orb']); } catch { return; }
      Menu.buildFromTemplate([{ label: '外观调参', click: () => { const w = this.openTuner(); w.show(); w.moveTop(); } }]).popup({ window: this.orb() });
    });
    ipcMain.on('appearance:pointer', (event, value: unknown) => { try { this.auth(event, ['orb']); } catch { return; } if (value === undefined || typeof value === 'boolean') this.hit(value); });
    ipcMain.on('appearance:placement', (event, value: unknown) => {
      try { this.auth(event, ['orb']); } catch { return; }
      if (!this.state.visible || !object(value) || typeof value.x !== 'number' || !Number.isFinite(value.x) || typeof value.y !== 'number' || !Number.isFinite(value.y) || typeof value.dragging !== 'boolean') return;
      this.anchor = constrainDesktop({ x: value.x, y: value.y }, this.state.displays!); this.dragging = value.dragging;
      if (this.dragging) { this.ignored = false; this.orb().setIgnoreMouseEvents(false); }
      else { this.state.monitor = this.state.displays!.find(d => d.id === this.geometry().activeMonitor)!; this.hit(); this.aligned(); }
    });
    ipcMain.on('appearance:telemetry', (event, value: Telemetry) => {
      try { this.auth(event, ['orb']); } catch { return; }
      if (!value || typeof value.status !== 'string' || JSON.stringify(value).length > 20000 || !Number.isFinite(value.liveTracks)) return;
      this.latest = value; const tuner = this.windows.get('appearance'); if (tuner && !tuner.isDestroyed() && !tuner.webContents.isDestroyed()) tuner.webContents.send('appearance:telemetry', value);
      if (this.state.enabled && value.liveTracks === 0 && /失败|来源已|上下文丢失|未收到|离开|位置无效|无法切换/.test(value.status)) {
        this.generation++; this.state.enabled = false; this.state.failure = value.status; this.publish();
      }
    });
  }
  closeTuner() { if (!this.disposed) this.send('appearance:diagnostic', 'preview-release'); }
}
