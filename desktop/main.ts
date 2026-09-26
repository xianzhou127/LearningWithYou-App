import { menuPlacementFor } from './glass/menu-geometry';
import { app, BaseWindow, BrowserWindow, desktopCapturer, dialog, ipcMain, Menu, nativeImage, nativeTheme, systemPreferences, protocol, safeStorage, screen, session as electronSession, Tray, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DesktopSession, type MediaPort } from "./session";
import { APP_ORIGIN, type MediaCommand, type MediaValue, type Role, type Source, type SourceChoice, type Diagnostics, type ViewAction, type Presentation } from "./shared";
import { adjacentBounds, constrain, inSystemCorner, roundedRegion, backdropRegion, TOOLBAR } from "./window-placement";
import { parseAction, parseView, roleCanAct, roleCanControlWindow, staticFiles, trustedFrame, validMediaEvent, validReply, validPcmPacket } from "./security";
import { readNativeCatalog, windowChoices } from "./sources";
import { ConfigurationStore } from "./config";
import { testAnalysisConnection, emptyConnectionTest } from "./connection-test";
import { CONFIGURATION_ERROR_COPY } from "./configuration-copy";
import { WindowPreferencesStore } from "./window-preferences";
import { createCloudServices } from "./services";
import { HistoryStore, validHistoryId } from "./history";
import type { Attachment, HistoryStatus } from "./history-types";
import { surfaceMaterial, type SurfaceMaterial } from "./material";
import { SurfaceMotion } from "./surface-motion";
import { attachSurfaceShadow } from "./surface-shadow";
import { AppearanceHost } from "./glass/host";
export { createCloudServices } from "./services";

const boot = performance.now();
let startupMs = 0;
let ending = false;
let mediaReady = false;
let blockedNetworkRequests = 0;
let requestId = 0;
let tray: Tray;
let trayStateKey = "";
let menuOpen = false;
let menuContentHeight = 270;
let menuPlacement: Presentation["menu"];
let feedbackOpen = false;
let presentationRevision = 0;
let actionNotice: string | null = null;
const directions = { menu: "down", feedback: "down" } as const satisfies Record<string, "up" | "down">;
const surfaceDirections: Record<"menu" | "feedback", "up" | "down"> = { ...directions };
const surfaceMotions = new Map<"menu" | "feedback", SurfaceMotion>();
const materials = new Map<Role, SurfaceMaterial>();
const nativeFrames = new Set<Role>();
let inactiveFeedbackTimer: ReturnType<typeof setTimeout> | undefined;
let displayGrant: Source | null = null;
let microphoneGrant = false;
let sourceRequest = false;
let selectionRequest = false;
let exportBusy = false;
let configurationBusy = false;
let connectionTest: AbortController | null = null;
let configuration: ConfigurationStore;
let windowPreferences: WindowPreferencesStore;
let windowPreferencesBusy = false;
let windowPreferencesApplyFailed = false;
export let appearance: AppearanceHost;
const windows = new Map<Role, BrowserWindow>();
const materialWindows = new WeakSet<BaseWindow>();
const catalog = new Map<string, Source>();
const sourceOwners = new Map<string, number>();
const pending = new Map<number, { resolve: (v: MediaValue) => void; reject: (e: Error) => void; cleanup: () => void }>();
const assetDir = path.join(__dirname, "renderer");

const urlFor = (role: Role) => `${APP_ORIGIN}/${role === "media" ? "media" : role === "orb" || role === "appearance" ? "glass" : "index"}.html?role=${role}`;
const localOrigin = (origin: string) => origin === APP_ORIGIN || origin === `${APP_ORIGIN}/`;

// Local renderers only; cloud requests and encrypted configuration stay in trusted Node.
protocol.registerSchemesAsPrivileged([{ scheme: "learning", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
app.enableSandbox();
app.setName("LearningWithYou T11");
app.setAppUserModelId("local.learningwithyou.t11");
// Stable identity: T12 keeps T11 encrypted configuration and future archives in place.
app.setPath("userData", path.resolve(app.commandLine.getSwitchValue("user-data-dir") || path.join(app.getPath("appData"), "LearningWithYou T11")));
export const history = new HistoryStore(app.getPath("userData"));
const singleton = app.requestSingleInstanceLock();
if (!singleton) app.quit();

function auth(event: IpcMainEvent | IpcMainInvokeEvent, roles: Role[]): Role {
  for (const role of roles) {
    const win = windows.get(role);
    if (win && !win.isDestroyed() && event.sender === win.webContents && trustedFrame(event.senderFrame?.url ?? "", role, event.senderFrame === event.sender.mainFrame)) return role;
  }
  throw new Error("IPC sender rejected");
}
const controls: Role[] = ["orb", "menu", "feedback", "panel", "settings", "picker", "history"];
const playbackBlocked = () => ["connecting", "starting", "recording", "stopping", "exiting"].includes(learning.snapshot().phase);
function historyStatus(): HistoryStatus {
  const s = learning.snapshot();
  return { revision: history.revision, saving: history.saving, clearing: history.clearing, error: history.error, playbackBlocked: playbackBlocked(),
    clearBlockedReason: history.clearing ? "正在清除历史，请稍候。" : s.busy || s.recording || history.hasActive || history.saving || history.error ? "录音、转写、分析或保存尚未结束，暂不能全部清除。" : null };
}
function historyChanged() { if (ending) return; for (const role of controls) { const win = windows.get(role); if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("t12:history-changed"); } }
history.subscribe(historyChanged);
async function stopPlayback() {
  await Promise.all(["history", "panel"].map(async role => {
    const win = windows.get(role as Role); if (!win || win.isDestroyed()) return;
    win.webContents.setAudioMuted(true);
    // Main-process constant, no renderer input. Await pause acknowledgement before granting microphone.
    await win.webContents.executeJavaScript("document.querySelectorAll('audio').forEach(a => { a.pause(); }); true");
  }));
}
const mediaPort: MediaPort = {
  async call(command, signal) {
    if (command.type === "start") { await stopPlayback(); if (signal?.aborted) throw new Error("cancelled"); }
    const win = windows.get("media");
    if (!win || win.isDestroyed() || !mediaReady) return Promise.reject(new Error("media"));
    const id = ++requestId;
    if (command.type === "select") displayGrant = command.source;
    if (command.type === "start") microphoneGrant = true;
    if (["finish", "cancel", "dispose"].includes(command.type)) { microphoneGrant = false; displayGrant = null; }
    return new Promise<MediaValue>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); pending.delete(id); if (command.type === "start") microphoneGrant = false; if (command.type === "select") displayGrant = null; };
      const abort = () => { cleanup(); reject(new Error("cancelled")); };
      const timer = setTimeout(() => { cleanup(); reject(new Error("timeout")); }, command.type === "dispose" || command.type === "cancel" ? 4000 : 20000);
      pending.set(id, { resolve, reject, cleanup }); signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      win.webContents.send("t10:media-command", { ...command, id } satisfies MediaCommand);
    });
  },
};
export const learning = new DesktopSession(mediaPort, () => {
  for (const motion of surfaceMotions.values()) motion.stop();
  surfaceMotions.clear(); clearTimeout(inactiveFeedbackTimer);
  ending = true; connectionTest?.abort(); appearance?.dispose(); tray?.destroy(); for (const win of windows.values()) if (!win.isDestroyed()) win.destroy(); app.quit();
}, createCloudServices(() => configuration?.snapshot() ?? {}), history);

function icon(recording: boolean) {
  const size = 32, pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const offset = (y * size + x) * 4;
    const inside = Math.hypot(x - 15.5, y - 15.5) < 14;
    const center = Math.hypot(x - 15.5, y - 15.5) < (recording ? 7 : 5);
    const color = center ? [255, 255, 255] : recording ? [178, 63, 75] : [53, 102, 216];
    pixels[offset] = color[2]; pixels[offset + 1] = color[1]; pixels[offset + 2] = color[0]; pixels[offset + 3] = inside ? 255 : 0;
  }
  return nativeImage.createFromBitmap(pixels, { width: size, height: size, scaleFactor: 1 });
}
function updateTray() {
  if (!tray || tray.isDestroyed()) return;
  const state = learning.snapshot();
  tray.setToolTip(state.recording ? `T14.5 · 录音中 ${Math.floor(state.elapsedMs / 1000)} 秒 · 云端转写` : `T14.5 · 未录音${state.phase === "feedback" ? " · 反馈已就绪" : ""}`);
  const key = `${state.phase}:${state.busy}:${state.recording}`;
  if (key === trayStateKey) return; // Keep an open native tray menu stable during timer updates.
  trayStateKey = key;
  tray.setImage(icon(state.recording));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: state.recording ? "● 正在录音和转写" : "未录音 · T14.5", enabled: false },
    { label: "显示悬浮入口", click: restore },
    { label: "停止录音并检查", enabled: state.phase === "recording" && !state.busy, click: () => { void learning.check(learning.snapshot().revision); } },
    { label: "本轮详情", click: () => show("panel", true) },
    { label: "设置", click: () => show("settings", true) },
    { label: "历史回顾", click: () => show("history", true) },
    { type: "separator" },
    { label: "退出并释放全部资源", click: () => { void requestQuit(); } },
  ]));
}
function publish() {
  if (ending) return;
  const state = learning.snapshot();
  // A new round closes presentation only; media lifetime stays in DesktopSession.
  if (!state.feedback && feedbackOpen) closeSurface("feedback");
  for (const [role, win] of windows) if (role !== "media" && !win.isDestroyed() && !win.webContents.isDestroyed() && !win.webContents.isLoadingMainFrame()) win.webContents.send("t10:state", state);
  for (const role of ["history", "panel"] as const) { const win = windows.get(role); if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.setAudioMuted(playbackBlocked() || !win.isVisible()); }
  historyChanged();
  updateTray();
}
learning.subscribe(publish);

function contentProtectionFor(win: BaseWindow, otherWindows: boolean) {
  // The capsule and inline menu must never enter their own background feed.
  // Native shadow windows inherit this policy from their owner as well.
  const owner = win.getParentWindow();
  return materialWindows.has(win) || (!!owner && materialWindows.has(owner)) || otherWindows;
}
function createWindow(role: Role, width: number, height: number) {
  const isMedia = role === "media";
  const isGlass = role === "orb";
  // Reading pages share one opaque surface and the normal desktop Z-order.
  // Only the capsule/menu remain in the persistent overlay layer.
  const floating = ["orb", "menu"].includes(role);
  const systemFrame = floating && !isGlass && surfaceMaterial(process.platform, os.release(), false, false) === "acrylic";
  if (systemFrame) nativeFrames.add(role);
  const pageWindow = roleCanControlWindow(role);
  const resizable = pageWindow || role === "appearance";
  const area = screen.getPrimaryDisplay().workArea;
  const actualWidth = Math.min(width, area.width - 24), actualHeight = Math.min(height, area.height - 24);
  const pageTitles: Partial<Record<Role, string>> = { picker: "选择学习资料", history: "历史回顾", panel: "本轮详情", settings: "设置", feedback: "本轮反馈" };
  const win = new BrowserWindow({
    title: pageTitles[role] ? `${pageTitles[role]} · LearningWithYou` : `T14.5 · ${role}`, width: actualWidth, height: actualHeight,
    x: area.x + area.width - actualWidth - 12, y: area.y + Math.min(80, area.height - actualHeight - 12),
    show: false, frame: role === "appearance", thickFrame: resizable, resizable,
    minWidth: resizable ? 460 : undefined,
    minHeight: resizable ? 360 : undefined,
    minimizable: pageWindow || role === "appearance", maximizable: pageWindow, fullscreenable: false,
    skipTaskbar: !pageWindow, alwaysOnTop: floating,
    backgroundColor: floating ? "#00000000" : "#f2f5f9", transparent: floating && !systemFrame, hasShadow: !floating,
    // Keep Acrylic's non-per-pixel surface, but remove the standard frame.
    // A single native region owns the large curve; no DWM corner/shadow overlap.
    backgroundMaterial: systemFrame ? "acrylic" : undefined,
    roundedCorners: !floating && !isMedia,
    webPreferences: { preload: path.join(__dirname, isMedia ? "media-preload.cjs" : "preload.cjs"),
      sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true,
      webviewTag: false, spellcheck: false, backgroundThrottling: !isMedia && !isGlass,
      partition: "t10-local", devTools: !app.isPackaged, focusOnNavigation: false },
  });
  if (role === "orb" || role === "menu") materialWindows.add(win);
  win.setContentProtection(contentProtectionFor(win, windowPreferences.status().contentProtection));
  if (floating && !isGlass) {
    const material = surfaceMaterial(process.platform, os.release(), nativeTheme.prefersReducedTransparency, nativeTheme.inForcedColorsMode);
    try { win.setBackgroundMaterial(material === "acrylic" ? "acrylic" : "none"); materials.set(role, material); }
    catch { materials.set(role, "solid"); }
  }
  if (floating) win.setAlwaysOnTop(true, "screen-saver");
  win.setMenu(null); windows.set(role, win);
  win.once("closed", () => { if (windows.get(role) === win) windows.delete(role); });
  if (pageWindow) {
    win.on("maximize", publishPresentation); win.on("unmaximize", publishPresentation);
    win.on("restore", publishPresentation);
  }
  if (role === "orb" || role === "menu") {
    let pendingBlur: ReturnType<typeof setImmediate> | undefined;
    win.on("blur", () => {
      clearImmediate(pendingBlur);
      pendingBlur = setImmediate(() => {
        pendingBlur = undefined;
        if (menuOpen && !windows.get("orb")?.isFocused() && !windows.get("menu")?.isFocused()) closeSurface("menu");
      });
    });
    win.once("closed", () => clearImmediate(pendingBlur));
  }
  const shadow = floating && !isGlass ? attachSurfaceShadow(win, 16, contentProtectionFor(win, windowPreferences.status().contentProtection)) : undefined;
  if (floating && !isGlass) {
    const updateRegion = () => {
      const bounds = win.getBounds(), zoom = win.webContents.getZoomFactor();
      win.setShape((systemFrame ? backdropRegion : roundedRegion)(bounds.width, bounds.height, 16 * zoom));
      shadow?.sync();
    };
    updateRegion();
    win.on("resize", updateRegion);
    // System transparency changes are respected without rebuilding the session.
    const updateMaterial = () => {
      if (win.isDestroyed()) return;
      const previous = materials.get(role);
      const material = surfaceMaterial(process.platform, os.release(), nativeTheme.prefersReducedTransparency, nativeTheme.inForcedColorsMode);
      try { win.setBackgroundMaterial(material === "acrylic" ? "acrylic" : "none"); materials.set(role, material); }
      catch { materials.set(role, "solid"); }
      updateRegion(); if (previous !== materials.get(role)) publishPresentation();
    };
    // Electron 44's public setter refreshes the non-client material without
    // activating the HWND. Reapply once after deactivation, never poll or focus.
    let pendingRefresh: ReturnType<typeof setImmediate> | undefined;
    const refreshAfterActivation = () => {
      if (pendingRefresh !== undefined || !systemFrame) return;
      pendingRefresh = setImmediate(() => { pendingRefresh = undefined; updateMaterial(); });
    };
    win.on("blur", refreshAfterActivation); win.on("show", refreshAfterActivation);
    if (systemFrame) win.hookWindowMessage(0x86, wParam => { if (!wParam.readUInt32LE()) refreshAfterActivation(); });
    nativeTheme.on("updated", updateMaterial);
    win.once("closed", () => { clearImmediate(pendingRefresh); nativeTheme.removeListener("updated", updateMaterial); });
  }
  if (role === "menu" || role === "feedback") {
    // Animate the complete native surface, including DWM's backdrop. A CSS-only
    // opacity/scale would leave a stationary Acrylic rectangle behind the HTML.
    surfaceMotions.set(role, new SurfaceMotion(progress => {
      if (!win.isDestroyed()) { win.setOpacity(progress); shadow?.setOpacity(progress); }
    }, () => { if (!win.isDestroyed()) win.hide(); }));
    win.setOpacity(0);
    shadow?.setOpacity(0);
  }
  if (role === "picker") win.on("show", () => win.webContents.send("t10:picker-opened"));
  if (role === "appearance") { win.setTitle("外观调参 · T15"); win.on("hide", () => appearance?.closeTuner()); }
  if (isGlass) win.webContents.on("before-input-event", (event, input) => { if (input.type === "keyDown" && input.key === "Escape") { event.preventDefault(); if (menuOpen) closeSurface("menu", true); else hideAll(); } });
  if (role === "menu") win.on("show", () => win.webContents.send("t10:menu-opened"));
  if (role === "settings") {
    win.on("show", () => { if (!win.webContents.isDestroyed()) win.webContents.send("t13:settings-visibility", true); });
    win.on("hide", () => { connectionTest?.abort(); if (!win.webContents.isDestroyed()) win.webContents.send("t13:settings-visibility", false); });
    win.on("closed", () => connectionTest?.abort());
    win.webContents.on("render-process-gone", () => connectionTest?.abort());
    win.webContents.on("did-start-navigation", () => connectionTest?.abort());
  }
  if (role === "history" || role === "panel") {
    const stopPlayback = () => { win.webContents.setAudioMuted(true); win.webContents.send("t12:stop-playback"); };
    win.on("hide", stopPlayback); win.on("minimize", stopPlayback);
    win.on("show", () => { win.webContents.setAudioMuted(playbackBlocked()); historyChanged(); });
    win.on("restore", () => { win.webContents.setAudioMuted(playbackBlocked()); historyChanged(); });
  }
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", event => event.preventDefault());
  win.webContents.on("will-attach-webview", event => event.preventDefault());
  win.webContents.on("will-prevent-unload", event => event.preventDefault());
  win.on("close", event => {
    if (ending || isMedia) return;
    event.preventDefault();
    if (role === "orb") hideAll(); else if (role === "menu" || role === "feedback") closeSurface(role, true); else win.hide();
  });
  win.webContents.on("render-process-gone", () => {
    if (ending || win.isDestroyed() || win.webContents.isDestroyed()) return;
    if (isMedia) {
      mediaReady = false;
      for (const item of [...pending.values()]) { item.cleanup(); item.reject(new Error("media")); }
      learning.hostFailed();
    }
    void win.loadURL(urlFor(role));
  });
  win.webContents.on("did-finish-load", () => { if (!ending && !win.isDestroyed() && !win.webContents.isDestroyed()) { publish(); publishPresentation(); } });
  void win.loadURL(urlFor(role)); return win;
}
function presentation(role: Role): Presentation {
  return { revision: presentationRevision, menu: menuPlacement, menuOpen, feedbackOpen, direction: role === "menu" ? surfaceDirections.menu : surfaceDirections.feedback, configured: learning.snapshot().simulated || !!configuration?.status().ready, notice: actionNotice, material: materials.get(role) ?? "solid", nativeFrame: nativeFrames.has(role), maximized: windows.get(role)?.isMaximized() ?? false };
}
function publishPresentation() {
  if (ending) return;
  presentationRevision++;
  for (const [role, win] of windows) if (role !== "media" && !win.isDestroyed() && !win.webContents.isDestroyed() && !win.webContents.isLoadingMainFrame()) win.webContents.send("t13:presentation", presentation(role));
}
function placeBeside(role: "menu" | "feedback") {
  if (role === "menu" && appearance) {
    menuPlacement = menuPlacementFor(appearance.geometry(), menuContentHeight);
    surfaceDirections.menu = menuPlacement.direction;
    appearance.menuBounds(menuOpen ? menuPlacement : null);
    return;
  }
  const orb = windows.get("orb")!, win = windows.get(role)!;
  const anchor = appearance?.visibleBounds() ?? orb.getBounds(), area = screen.getDisplayMatching(anchor).workArea;
  const scale = role === "menu" ? 1 : win.webContents.getZoomFactor();
  const size = role === "menu" ? { width: Math.ceil(252 * scale), height: Math.ceil(menuContentHeight * scale) } : { width: 440 * scale, height: 560 * scale };
  const placement = adjacentBounds(anchor, area, size);
  surfaceDirections[role] = placement.direction;
  if (role === "menu") {
    menuPlacement = { bounds: screen.dipToScreenRect(null, placement.bounds), scale: screen.getDisplayMatching(placement.bounds).scaleFactor, direction: placement.direction };
    appearance?.menuBounds(menuOpen ? menuPlacement : null);
  } else win.setBounds(placement.bounds, false);
}
function closeSurface(role: "menu" | "feedback", returnFocus = false, immediate = false) {
  if (role === "menu") { menuOpen = false; appearance?.menuBounds(null); publishPresentation(); return; }
  const win = windows.get(role);
  feedbackOpen = false;
  if (!win || win.isDestroyed()) return;
  publishPresentation();
  // Closing immediately releases pointer hit testing. Reopening cancels the timer.
  win.setIgnoreMouseEvents(true);
  if (returnFocus && win.isFocused()) windows.get("orb")?.focus();
  surfaceMotions.get(role)?.set(false, immediate || systemPreferences.getAnimationSettings().prefersReducedMotion);
}
function show(role: "menu" | "feedback" | "panel" | "settings" | "picker" | "history", active: boolean) {
  if (role === "feedback" && !learning.snapshot().feedback) return;
  if (role !== "history") learning.setHidden(false);
  if (role === "menu") {
    if (ending) return; menuOpen = true; placeBeside("menu"); publishPresentation();
    if (active) windows.get("orb")?.focus(); return;
  }
  const win = windows.get(role)!;
  if (ending || !win || win.isDestroyed()) return;
  if (role === "feedback") {
    placeBeside(role);
    feedbackOpen = true;
    win.setIgnoreMouseEvents(false);
    surfaceMotions.get(role)?.set(true, systemPreferences.getAnimationSettings().prefersReducedMotion);
  }
  if (active) {
    if (win.isMinimized()) win.restore();
    win.show(); win.moveTop(); win.focus();
  } else win.showInactive();
  if (role === "feedback") updateSurfacePointer(role);
  publishPresentation(); win.moveTop(); keepOrbOnTop();
}
function updateSurfacePointer(role: Role) {
  const win = windows.get(role);
  if (!win || win.isDestroyed() || !nativeFrames.has(role)) return;
  const cursor = screen.getCursorScreenPoint(), bounds = win.getContentBounds();
  const closing = role === "menu" ? !menuOpen : role === "feedback" ? !feedbackOpen : false;
  win.setIgnoreMouseEvents(closing || inSystemCorner(cursor.x - bounds.x, cursor.y - bounds.y, bounds.width, bounds.height, (role === "orb" ? 20 : 16) * win.webContents.getZoomFactor()), { forward: true });
}
function hideAll() {
  clearTimeout(inactiveFeedbackTimer);
  closeSurface("menu", false, true); closeSurface("feedback", false, true);
  appearance?.visible(false); windows.get("appearance")?.hide();
  controls.forEach(role => windows.get(role)?.hide()); learning.setHidden(true);
}
function keepOrbOnTop() {
  const orb = windows.get("orb");
  if (!orb || orb.isDestroyed() || !orb.isVisible() || learning.snapshot().hidden) return;
  orb.setAlwaysOnTop(true, "screen-saver");
  orb.moveTop(); // Reorder without activating or stealing the document's keyboard focus.
}
function restore() { learning.setHidden(false); windows.get("orb")?.showInactive(); updateSurfacePointer("orb"); publishPresentation(); keepOrbOnTop(); }
async function requestQuit() {
  connectionTest?.abort();
  const result = await learning.quit();
  // A tray/OS quit can originate while every window is hidden. Make a failed save visible.
  if (!result.ok && !ending) show("panel", true);
  return result;
}
function moveToolbar(dx: number, dy: number) {
  if (appearance) { appearance.move(dx, dy); return; }
  const win = windows.get("orb")!, bounds = win.getBounds();
  const area = screen.getDisplayMatching(bounds).workArea;
  win.setBounds(constrain({ ...TOOLBAR, x: bounds.x + dx, y: bounds.y + dy }, area), false);
  if (menuOpen) placeBeside("menu"); if (feedbackOpen) placeBeside("feedback"); publishPresentation();
}
function handleView(role: Role, action: ViewAction) {
  switch (action) {
    case "minimize": case "toggle-maximize": {
      // Authenticated sender controls only its own menu page, never an id from IPC.
      if (!roleCanControlWindow(role)) throw new Error("Window control denied");
      const win = windows.get(role);
      if (ending || !win || win.isDestroyed()) return;
      if (action === "minimize") win.minimize();
      else if (win.isMaximized()) win.unmaximize(); else win.maximize();
      return;
    }
    case "operation-failed": actionNotice = "操作未完成，请查看当前状态后重试。"; publishPresentation(); return;
    case "hover-enter": case "hover-leave": return; // Core actions no longer depend on hover.
    case "move-left": case "move-right": case "move-up": case "move-down":
      if (role === "orb") moveToolbar(action === "move-left" ? -16 : action === "move-right" ? 16 : 0, action === "move-up" ? -16 : action === "move-down" ? 16 : 0); return;
    case "toggle-menu":
      if (role !== "orb") return;
      // Explicitly opening the inline menu gives its host keyboard focus, so
      // leaving it produces the native blur event that owns automatic dismissal.
      if (menuOpen) closeSurface("menu", true); else { closeSurface("feedback"); show("menu", true); } return;
    case "toggle-feedback":
      if (role !== "orb") return;
      if (feedbackOpen) closeSurface("feedback", true); else show("feedback", true); return;
    case "collapse": closeSurface("menu", true); if (role === "orb" || role === "feedback") closeSurface("feedback", true); return;
    // Navigation does not dismiss the menu itself. An activated destination
    // closes it through blur; inactive destinations leave the menu available.
    case "feedback": show("feedback", true); return;
    case "feedback-inactive": if (role === "panel") {
      clearTimeout(inactiveFeedbackTimer); const roundId = learning.snapshot().roundId;
      inactiveFeedbackTimer = setTimeout(() => { if (learning.snapshot().roundId === roundId) show("feedback", false); }, 3000);
    } return;
    case "panel": case "settings": case "history": closeSurface("feedback"); show(action, true); return;
    case "picker": if (!learning.snapshot().busy && !learning.snapshot().recording) { closeSurface("feedback"); show("picker", true); } return;
    case "hide": hideAll(); return;
    case "restore": restore(); return;
    case "close": if (role === "menu" || role === "feedback") closeSurface(role, true); else if (role !== "orb") windows.get(role)?.hide(); return;
  }
}
async function diagnostics(): Promise<Diagnostics> {
  const metrics = app.getAppMetrics();
  return {
    platform: process.platform, osVersion: os.release(), electron: process.versions.electron, chrome: process.versions.chrome,
    packaged: app.isPackaged, startupMs,
    displays: screen.getAllDisplays().map(d => ({ width: d.size.width, height: d.size.height, scaleFactor: d.scaleFactor })),
    windows: [...windows].map(([role, win]) => ({ role, bounds: win.getBounds(), visible: win.isVisible(), contentProtected: win.isContentProtected(), backgroundThrottling: win.webContents.getBackgroundThrottling() })),
    resources: { processes: metrics.length, workingSetMB: metrics.reduce((sum, m) => sum + m.memory.workingSetSize / 1024, 0), privateMB: metrics.reduce((sum, m) => sum + (m.memory.privateBytes ?? 0) / 1024, 0), cpuPercent: metrics.reduce((sum, m) => sum + m.cpu.percentCPUUsage, 0) },
    blockedNetworkRequests, adapter: learning.snapshot().simulated ? "simulated" : "cloud",
  };
}
async function exportEvidence() {
  if (exportBusy || learning.snapshot().recording || learning.snapshot().busy) return null;
  exportBusy = true;
  try {
    const snapshot = learning.snapshot(), data = learning.artifacts();
    const result = await dialog.showOpenDialog(windows.get("panel")!, { title: "仅导出你准备的本轮测试资料和声音，请选择保存目录", properties: ["openDirectory", "createDirectory"] });
    if (result.canceled || !result.filePaths[0]) return null;
    const dir = path.join(result.filePaths[0], `T11-evidence-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    await mkdir(dir); // Unique child directory; renderer cannot supply paths or filenames.
    if (data.start) await writeFile(path.join(dir, "start.jpg"), Buffer.from(data.start.dataUrl.split(",")[1], "base64"));
    if (data.end) await writeFile(path.join(dir, "end.jpg"), Buffer.from(data.end.dataUrl.split(",")[1], "base64"));
    if (data.audio) await writeFile(path.join(dir, "recording.webm"), Buffer.from(data.audio.bytes));
    await writeFile(path.join(dir, "evidence.json"), JSON.stringify({ notice: "用户明确导出的当前测试轮次。图像来自最终捕获链路；排除、焦点及真实声音需人工核对。", snapshot, diagnostics: await diagnostics() }, null, 2));
    return dir;
  } finally { exportBusy = false; }
}
function installIpc() {
  ipcMain.on("t14:surface-pointer", event => {
    let role: Role;
    try { role = auth(event, ["orb", "menu", "feedback"]); } catch { return; }
    // No renderer-controlled coordinates or requested mode: use the native cursor.
    updateSurfacePointer(role);
  });
  ipcMain.handle("t13:presentation", event => presentation(auth(event, controls)));
  ipcMain.handle("t12:history-status", event => { auth(event, controls); return historyStatus(); });
  ipcMain.handle("t12:history-list", (event, offset: unknown) => { auth(event, ["history"]); if (typeof offset !== "number") throw new Error("Invalid page"); return history.list(offset); });
  ipcMain.handle("t12:history-detail", (event, id: unknown) => { auth(event, ["history"]); if (!validHistoryId(id)) throw new Error("Invalid ID"); return history.detail(id); });
  ipcMain.handle("t12:history-delete", async (event, id: unknown) => {
    auth(event, ["history"]); if (!validHistoryId(id)) throw new Error("Invalid ID");
    try { await history.delete(id); return { ok: true }; } catch { return { ok: false, message: "删除失败：记录可能正在写入或等待结果，或目录不可写。请刷新后重试。" }; }
  });
  ipcMain.handle("t12:history-clear", async event => {
    auth(event, ["history"]);
    try {
      const cleared = await history.clear(async count => {
        const result = await dialog.showMessageBox(windows.get("history")!, { type: "warning", title: "清除全部历史", message: `将永久删除 ${count} 条历史记录及其截图、录音、转写和反馈。`, detail: "仅清除学习历史，不影响 API 配置、当前会话或主动导出的文件。此操作无法撤销。", buttons: ["取消", `删除全部 ${count} 条`], defaultId: 0, cancelId: 0, noLink: true });
        return result.response === 1;
      }, () => learning.snapshot().busy || learning.snapshot().recording);
      return { ok: true, message: cleared ? "全部历史已清除。" : "已取消或没有历史记录。" };
    } catch { return { ok: false, message: "全部清除未完成：录音、转写、分析或保存中不可清除；也可能是目录无法删除。请刷新查看剩余记录后重试。" }; }
  });
  ipcMain.handle("t10:state", event => { auth(event, controls); return learning.snapshot(); });
  ipcMain.handle("t10:action", async (event, value: unknown) => {
    const role = auth(event, controls); const action = parseAction(value);
    if (!roleCanAct(role, action)) throw new Error("Action denied");
    actionNotice = null; publishPresentation();
    const perform = async () => {
    if (action.type === "select") {
      const source = catalog.get(action.sourceId); if (!source) return { ok: false, message: "来源已失效，请刷新列表。" };
      if (selectionRequest || learning.snapshot().busy || learning.snapshot().recording) return { ok: false, message: "请等待当前操作结束。" };
      selectionRequest = true;
      const revision = learning.snapshot().revision;
      try {
        const fresh = await readNativeCatalog();
        if (learning.snapshot().revision !== revision) return { ok: false, message: "会话已改变，请重新选择。" };
        if (catalog.get(source.id) !== source) return { ok: false, message: "列表已更新，请重新选择。" };
        if (source.kind === "window") {
          const window = fresh.windows.find(w => w.id === source.id && w.pid === sourceOwners.get(source.id));
          if (!window) return { ok: false, message: "窗口已关闭或不可用，请刷新列表。" };
          if (window.minimized) return { ok: false, message: "这个窗口已最小化，请先从任务栏恢复，再刷新选择。" };
        } else if (!fresh.monitors.some(m => m.id === source.id)) return { ok: false, message: "屏幕已断开，请刷新列表。" };
        const result = await learning.select(source);
        if (result.ok) { catalog.clear(); sourceOwners.clear(); windows.get("picker")?.hide(); restore(); } return result;
      } finally { selectionRequest = false; }
    }
    if (action.type === "quit") return requestQuit();
    if (action.type === "cancel") return learning.cancel();
    if (action.type === "end") return learning.cancel(true);
    if (action.type === "retry") return learning.retry(action.revision);
    return action.type === "start" ? learning.start(action.revision) : learning.check(action.revision);
    };
    const result = await perform();
    if (!ending && !result.ok && result.message) { actionNotice = result.message; publishPresentation(); }
    return result;
  });
  ipcMain.handle("t10:view", (event, value: unknown) => { const role = auth(event, controls); handleView(role, parseView(value)); });
  ipcMain.handle("t10:sources", async (event, kind: unknown): Promise<SourceChoice[]> => {
    auth(event, ["picker"]);
    if ((kind !== "window" && kind !== "screen") || sourceRequest || selectionRequest || learning.snapshot().recording || learning.snapshot().busy) return [];
    sourceRequest = true; catalog.clear(); sourceOwners.clear();
    try {
      const ownIds = new Set(BrowserWindow.getAllWindows().map(win => win.getMediaSourceId()));
      const [native, previews] = await Promise.all([
        readNativeCatalog(),
        desktopCapturer.getSources({ types: [kind], thumbnailSize: { width: 320, height: 200 }, fetchWindowIcons: false }).catch(() => []),
      ]);
      const thumbnails = new Map(previews.filter(s => !s.thumbnail.isEmpty()).map(s => [s.id, s.thumbnail.toDataURL()]));
      const choices: SourceChoice[] = kind === "window" ? windowChoices(native, ownIds, process.pid, thumbnails) :
        native.monitors.sort((a, b) => Number(b.primary) - Number(a.primary) || a.x - b.x || a.y - b.y).map((m, i) => {
          const physical = { x: m.x, y: m.y, width: m.width, height: m.height };
          const display = screen.getDisplayMatching(screen.screenToDipRect(null, physical));
          return { id: m.id, name: `屏幕 ${i + 1}${m.primary ? " · 主屏" : " · 副屏"}`, kind: "screen", displayId: String(display.id),
            thumbnail: thumbnails.get(m.id) ?? "", available: true, detail: `${m.width} × ${m.height} · ${Math.round(display.scaleFactor * 100)}% 缩放` };
        });
      for (const choice of choices) {
        const { id, name, kind, displayId } = choice;
        catalog.set(id, { id, name, kind, ...(displayId ? { displayId } : {}) });
      }
      for (const window of native.windows) sourceOwners.set(window.id, window.pid);
      return choices;
    } finally { sourceRequest = false; }
  });
  ipcMain.handle("t10:diagnostics", event => { auth(event, ["panel"]); return diagnostics(); });
  ipcMain.handle("t10:export", event => { auth(event, ["panel"]); return exportEvidence(); });
  ipcMain.handle("t15:window-preferences", async (event, value: unknown) => {
    auth(event, ["settings"]);
    if (value !== undefined && typeof value !== "boolean") throw new Error("Window preference denied");
    const status = () => ({ ...windowPreferences.status(), error: windowPreferencesApplyFailed ? "apply_failed" as const : windowPreferences.status().error });
    if (value === undefined) return status();
    if (windowPreferencesBusy || ending) throw new Error("Window preference operation unavailable");
    windowPreferencesBusy = true;
    try {
      const saved = await windowPreferences.save(value);
      if (saved.error) return saved;
      windowPreferencesApplyFailed = false;
      // Apply the preference only to other surfaces; material hosts and their
      // shadows stay excluded even when this preference is false.
      for (const win of BaseWindow.getAllWindows()) {
        if (win.isDestroyed()) continue;
        try { win.setContentProtection(contentProtectionFor(win, saved.contentProtection)); }
        catch { if (!win.isDestroyed()) windowPreferencesApplyFailed = true; }
      }
      return status();
    } finally { windowPreferencesBusy = false; }
  });
  ipcMain.handle("t11:configuration", async (event, action: unknown, draft: unknown) => {
    auth(event, ["settings"]);
    const mutations = ["add-analysis", "add-asr", "select-analysis", "select-asr", "delete-analysis", "delete-asr"];
    if (typeof action !== "string" || !["status", "import", "clear", ...mutations].includes(action) || (!mutations.includes(action) && draft !== undefined)) throw new Error("Configuration action denied");
    if (action === "status") return configuration.status();
    if (configurationBusy || connectionTest || ending) throw new Error("Configuration operation unavailable");
    configurationBusy = true;
    try {
      if (action === "clear") return await configuration.clear();
      if (mutations.includes(action)) return await configuration.mutate(action as import("./shared").ConfigurationMutation, draft);
      const result = await dialog.showOpenDialog(windows.get("settings")!, { title: "导入分析与转写配置（兼容旧配置）", properties: ["openFile"], filters: [{ name: "配置文件", extensions: ["env", "local", "txt"] }, { name: "所有文件", extensions: ["*"] }] });
      if (result.canceled || !result.filePaths[0] || ending) return configuration.status();
      return await configuration.importFile(result.filePaths[0]);
    } finally { configurationBusy = false; publishPresentation(); }
  });
  ipcMain.handle("t16:test-analysis", async (event, action: unknown, draft: unknown) => {
    auth(event, ["settings"]);
    if (action === "cancel" && draft === undefined) { connectionTest?.abort(); return null; }
    if (action !== "start" || ending || connectionTest || configurationBusy || !windows.get("settings")?.isVisible()) throw new Error("Connection test unavailable");
    const resolved = configuration.resolveAnalysisTest(draft);
    if ("error" in resolved) return { ...emptyConnectionTest(), error: CONFIGURATION_ERROR_COPY[resolved.error] };
    const controller = new AbortController(); connectionTest = controller;
    try { return await testAnalysisConnection(resolved.config, controller.signal); }
    catch { return { ...emptyConnectionTest(), cancelled: controller.signal.aborted, error: "连接测试未完成，请重试。" }; }
    finally { if (connectionTest === controller) connectionTest = null; }
  });
  ipcMain.handle("t11:pcm", (event, value: unknown) => {
    auth(event, ["media"]);
    if (!validPcmPacket(value)) {
      const state = learning.snapshot();
      learning.handleMediaEvent({ kind: "pcm-error", sessionId: state.sessionId, roundId: state.roundId }); return false;
    }
    return learning.receivePcm(value);
  });
  ipcMain.on("t13:menu-height", (event, height: unknown) => {
    try { auth(event, ["orb"]); } catch { return; }
    if (typeof height !== "number" || !Number.isFinite(height) || height < 100 || height > 2048 || ending) return;
    const next = Math.ceil(height);
    if (next === menuContentHeight) return;
    menuContentHeight = next;
    if (menuOpen) { placeBeside("menu"); publishPresentation(); }
  });
  ipcMain.on("t10:media-ready", event => { try { auth(event, ["media"]); mediaReady = true; } catch { /* Untrusted sender. */ } });
  ipcMain.on("t10:media-reply", (event, reply: unknown) => {
    try { auth(event, ["media"]); } catch { return; }
    if (!validReply(reply)) return;
    const item = pending.get(reply.id); if (!item) return;
    item.cleanup(); if (reply.error) item.reject(new Error(reply.error)); else if (reply.value) item.resolve(reply.value);
  });
  ipcMain.on("t10:media-event", (event, value: unknown) => {
    try { auth(event, ["media"]); } catch { return; }
    if (validMediaEvent(value)) learning.handleMediaEvent(value);
  });
}

if (singleton) void app.whenReady().then(async () => {
  windowPreferences = new WindowPreferencesStore(app.getPath("userData"));
  await windowPreferences.load();
  configuration = new ConfigurationStore(path.join(app.getPath("userData"), "secure-config"), safeStorage);
  await configuration.load();
  appearance = new AppearanceHost(windows, auth, () => windows.get("appearance") ?? createWindow("appearance", 780, 800), () => {
    if (menuOpen) placeBeside("menu"); if (feedbackOpen) placeBeside("feedback"); publishPresentation();
  }, () => learning.snapshot());
  await appearance.load();
  const ses = electronSession.fromPartition("t10-local");
  ses.webRequest.onBeforeRequest((details, callback) => {
    const allowed = details.url.startsWith(`${APP_ORIGIN}/`) || details.url.startsWith("devtools://");
    if (!allowed) blockedNetworkRequests++;
    callback({ cancel: !allowed });
  });
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    const media = windows.get("media");
    const types = "mediaTypes" in details ? details.mediaTypes : undefined;
    if (appearance.isOrb(contents)) { callback(details.isMainFrame && details.requestingUrl === urlFor("orb") && appearance.permission(contents, permission, types)); return; }
    const microphone = microphoneGrant && types?.length === 1 && types[0] === "audio";
    // Electron 44 requests media permission with an empty list before its display handler.
    // A one-use source grant must already exist from an explicit source choice.
    const display = !!displayGrant && types?.length === 0;
    callback(!!media && contents === media.webContents && details.isMainFrame && details.requestingUrl === urlFor("media") && permission === "media" && (microphone || display));
  });
  ses.setPermissionCheckHandler((contents, permission, origin, details) => {
    if (appearance.isOrb(contents)) return localOrigin(origin) && contents?.getURL() === urlFor("orb") && permission === "display-capture" && appearance.permission(contents, permission);
    const media = windows.get("media");
    return !!media && contents === media.webContents && localOrigin(origin) && contents.getURL() === urlFor("media")
      && permission === "media" && ((details.mediaType === "audio" && microphoneGrant) || (details.mediaType === "video" && !!displayGrant));
  });
  ses.setDisplayMediaRequestHandler((request, callback) => {
    if (request.frame === windows.get("orb")?.webContents.mainFrame) { void appearance.displayRequest(request, callback); return; }
    const media = windows.get("media"); const source = displayGrant; displayGrant = null;
    if (!media || request.frame !== media.webContents.mainFrame || !localOrigin(request.securityOrigin) || !source || !request.videoRequested || request.audioRequested) { callback({}); return; }
    callback({ video: source });
  });
  ses.on("will-download", event => event.preventDefault());
  ses.protocol.handle("learning", async request => {
    const url = new URL(request.url);
    if (url.host !== "app" || request.method !== "GET") return new Response(null, { status: 403 });
    const headers = { "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'none'; worker-src 'self'; frame-src 'none'; base-uri 'none'; form-action 'none'", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
    const resource = staticFiles[url.pathname];
    if (resource) return new Response(await readFile(path.join(assetDir, resource.file)), { headers: { ...headers, "Content-Type": resource.mime } });
    const archived = /^\/history\/([0-9a-f-]+)\/(start|end|audio)$/.exec(url.pathname);
    if (archived && validHistoryId(archived[1])) {
      if (archived[2] === "audio" && playbackBlocked()) return new Response(null, { status: 409 });
      try { return await history.media(archived[1], archived[2] as Attachment, request.headers.get("range")); }
      catch { return new Response(null, { status: 404 }); }
    }
    const state = learning.snapshot();
    if (url.searchParams.get("round") !== String(state.roundId)) return new Response(null, { status: 404 });
    const data = learning.artifacts();
    if (url.pathname === "/evidence/start.jpg" || url.pathname === "/evidence/end.jpg") {
      const shot = url.pathname.includes("start") ? data.start : data.end;
      if (shot) return new Response(Buffer.from(shot.dataUrl.split(",")[1], "base64"), { headers: { ...headers, "Content-Type": "image/jpeg" } });
    }
    if (url.pathname === "/evidence/recording.webm" && data.audio) {
      const bytes = Buffer.from(data.audio.bytes), range = request.headers.get("range")?.match(/^bytes=(\d+)-(\d*)$/);
      if (range) {
        const start = Number(range[1]), end = Math.min(range[2] ? Number(range[2]) : bytes.length - 1, bytes.length - 1);
        if (start > end || start >= bytes.length) return new Response(null, { status: 416 });
        return new Response(bytes.subarray(start, end + 1), { status: 206, headers: { ...headers, "Content-Type": data.audio.mime, "Accept-Ranges": "bytes", "Content-Range": `bytes ${start}-${end}/${bytes.length}`, "Content-Length": String(end - start + 1) } });
      }
      return new Response(bytes, { headers: { ...headers, "Content-Type": data.audio.mime, "Accept-Ranges": "bytes", "Content-Length": String(bytes.length) } });
    }
    return new Response(null, { status: 404 });
  });
  installIpc(); appearance.install(); Menu.setApplicationMenu(null);
  createWindow("media", 320, 200); createWindow("orb", TOOLBAR.width, TOOLBAR.height);
  createWindow("feedback", 440, 560); createWindow("panel", 960, 720); createWindow("picker", 760, 620);
  createWindow("history", 1040, 760);
  createWindow("settings", 580, 640);
  appearance.attach();
  tray = new Tray(icon(false)); tray.on("click", restore); tray.on("double-click", () => show("panel", true)); updateTray();
  const orb = windows.get("orb")!;
  orb.once("ready-to-show", () => {
    // Correct constructor rounding once; later movement always uses canonical dimensions.
    startupMs = Math.round(performance.now() - boot); restore();
  });
  setInterval(keepOrbOnTop, 1000).unref();
  setInterval(() => { if (learning.snapshot().recording) publish(); }, 1000).unref();
});
app.on("second-instance", restore);
app.on("before-quit", event => { if (ending || !singleton) return; event.preventDefault(); void requestQuit(); });
app.on("window-all-closed", () => { if (ending) app.quit(); });
