import { LiquidMenu } from './menu';
import type { MenuMaterial } from './menu-material';
import { roundedMenuHit } from './menu-geometry';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { LearningToolbar } from '../learning-surfaces';
import type { Snapshot, Presentation } from '../shared';
import type { Configuration, Geometry } from './contract';
import { MaterialCapture } from './capture';
import { clampAnchor, percentile, motionHit } from './geometry';
import { observeReadingLayout, applyInkTones } from './readability';
import { MotionInput } from './motion-input';
import { ForegroundMask } from './foreground-mask';
import './api';
import type { AppearanceState } from './api';
import { useHistoryStatus } from '../history-view';
import { constrainDesktop, desktopGeometry, nearestMonitor } from './desktop-layout';
function useSession() {
  const [state, setState] = useState<Snapshot | null>(null);
  useEffect(() => { const receive = (value: Snapshot) => setState(previous => previous && previous.revision > value.revision ? previous : value); const off = window.desktop.subscribe(receive); void window.desktop.state().then(receive); return off; }, []);
  useEffect(() => { if (!state?.recording) return; const timer = setInterval(() => { void window.desktop.state().then(value => setState(previous => previous && previous.revision > value.revision ? previous : value)); }, 500); return () => clearInterval(timer); }, [state?.recording]);
  return state;
}
export function Capsule() {
  const captureRef = useRef<MaterialCapture | null>(null), menuRef = useRef<MenuMaterial | null>(null);
  const [config, setConfig] = useState<Configuration | null>(null);
  const attachMenu = useCallback((value: MenuMaterial | null) => { menuRef.current = value; captureRef.current?.setMenu(value); }, []);
  const wakeMenu = useCallback(() => captureRef.current?.requestPresent(), []);
  const state = useSession(); const host = useRef<HTMLDivElement>(null); const shell = useRef<HTMLDivElement>(null);
  const historyStatus = useHistoryStatus();
  const sending = useRef(false);
  const [presentation, setPresentation] = useState<Presentation>({ revision: -1, configured: false, menuOpen: false, feedbackOpen: false, direction: 'down', notice: null });
  useEffect(() => { const receive = (v: Presentation) => setPresentation(old => old.revision > v.revision ? old : v); const off = window.desktop.onPresentation(receive); void window.desktop.presentation().then(receive); return off; }, []);
  const [active, setActive] = useState(false); const [status, setStatus] = useState('采集关闭');
  const [debugLabel, setDebugLabel] = useState('');
  const [materialNotice, setMaterialNotice] = useState<string | null>(null);
  const motion = useRef<MotionInput | null>(null);
  const latestState = useRef(state);
  const feedback = useRef({ key: '', allowed: false });
  useLayoutEffect(() => {
    latestState.current = state;
    if (!state || !motion.current) return;
    const input = motion.current, key = `${state.sessionId}:${state.roundId}`;
    const apply = () => { input.engine.snapshot({ ...state, feedback: feedback.current.key === key && feedback.current.allowed ? state.feedback : null }, performance.now()); input.request(); };
    if (state.phase === 'feedback' && state.feedback && feedback.current.key !== key) {
      feedback.current = { key, allowed: false };
      void window.appearance.consumeFeedback(state.sessionId, state.roundId).then(allowed => { if (latestState.current?.sessionId === state.sessionId && latestState.current.roundId === state.roundId && motion.current === input) { feedback.current = { key, allowed }; apply(); } });
    } else apply();
  }, [state]);
  useEffect(() => {
    const element = shell.current!;
    let disposed = false, configRevision = -1;
    let anchor = { x: 0, y: 0 }, current: Geometry | null = null;
    let drag: { id: number; dx: number; dy: number } | null = null;
    let pending: { x: number; y: number; at: number } | null = null, pointerRaf = 0;
    let cursor: { x: number; y: number } | null = null, lastHit: boolean | undefined;
    let pointerEvents = 0, placementFrames = 0, lastPlacement = 0;
    const inputAges: number[] = [], dragGaps: number[] = [];
    const moveEvent = 'onpointerrawupdate' in window ? 'pointerrawupdate' : 'pointermove';
    const input = new MotionInput(element, () => capture.requestPresent()); motion.current = input;
    let motionConfig: Configuration | null = null;
    const capture: MaterialCapture = new MaterialCapture(host.current!, (text, live, pending) => {
      const awaitingVisibleFrame = !live && motionConfig?.enabled && motionConfig.mode !== 'A' && (!motionConfig.visible || document.hidden);
      element.dataset.presentation = pending || awaitingVisibleFrame ? 'pending' : live ? 'live' : 'fallback';
      element.classList.toggle('has-material', live);
      setStatus(text); setActive(live);
      if (/失败|来源已结束|暂停|无效|离开|未收到|丢失|隐藏/.test(text)) { input.cancel(); input.engine.reset(); input.sample(performance.now()); endDrag(); }
    }, () => anchor, now => {
      flush();
      if (latestState.current) { const s = latestState.current; input.engine.snapshot({ ...s, feedback: feedback.current.key === `${s.sessionId}:${s.roundId}` && feedback.current.allowed ? s.feedback : null }, now); }
      const changed = input.sample(now); capture.motionChanged(input.pose, changed); syncHit();
    }, () => ({ pointerEvents, placementFrames, inputAgeMsP95: percentile(inputAges, .95), dragFrameGapMsP95: percentile(dragGaps, .95), pointerInput: moveEvent,
      motion: { peaks: { ...input.peaks }, events: { ...input.engine.events }, active: input.pose.active, frames: input.frames, draws: capture.motionDraws, exclusiveDraws: capture.motionExclusiveDraws, sharedDraws: capture.motionSharedDraws, notifications: input.engine.notifications }
    }), tones => applyInkTones(element, tones));
    captureRef.current = capture; capture.setMenu(menuRef.current);
    const foreground = new ForegroundMask(element, () => capture.positionChanged()); capture.foreground = foreground; foreground.motion = () => input.pose;
    const stopReadingLayout = observeReadingLayout(element, rects => capture.readingLayout(rects));
    const present = (point: { x: number; y: number }) => {
      if (current?.desktop) {
        anchor = constrainDesktop(point, current.desktop.monitors);
        const g = desktopGeometry(current.desktop, anchor), dpr = devicePixelRatio;
        element.style.transformOrigin = '0 0';
        element.style.transform = `translate3d(${(anchor.x - current.desktop.host.x) / dpr}px, ${(anchor.y - current.desktop.host.y) / dpr}px, 0) scale(${g.scale / dpr})`;
        menuRef.current?.position(g);
        capture.positionChanged();
        if (!drag) window.appearance.placement({ ...anchor, dragging: false });
        return;
      }
      const bounds = current?.display;
      anchor = clampAnchor(point, { width: Math.min(current?.hostSize?.width ?? innerWidth, bounds?.width ?? innerWidth), height: Math.min(current?.hostSize?.height ?? innerHeight, bounds?.height ?? innerHeight) });
      // One renderer transaction: the controls and the sampled video region use
      // this same position. No native window move or main-process round trip.
      element.style.transform = `translate3d(${anchor.x}px, ${anchor.y}px, 0)`;
      capture.positionChanged();
      // Main-process hit testing stays locked during capture. It needs the final
      // placement on release, not an IPC + native geometry query on every frame.
      if (!drag) window.appearance.placement({ ...anchor, dragging: false });
    };
    const flush = () => {
      if (!pending) return;
      const point = pending; pending = null;
      const now = performance.now(); inputAges.push(Math.max(0, now - point.at)); if (inputAges.length > 120) inputAges.shift();
      if (lastPlacement) { dragGaps.push(now - lastPlacement); if (dragGaps.length > 120) dragGaps.shift(); }
      if (lastPlacement) { const dt = Math.max(1, now - lastPlacement) / 1000, scale = current?.desktop ? desktopGeometry(current.desktop, anchor).scale : 1; input.engine.velocity((point.x - anchor.x) / scale / dt, (point.y - anchor.y) / scale / dt, now); }
      lastPlacement = now; placementFrames++; present(point);
    };
    const finishDrag = (cancelled: boolean) => {
      if (!drag) return;
      // Final pointer position, DOM and GPU commit together before releasing
      // capture. A paced RAF must not leave the background at the prior anchor.
      if (pending) capture.flushPresent();
      const id = drag.id; drag = null;
      if (element.hasPointerCapture(id)) element.releasePointerCapture(id);
      element.removeAttribute('data-dragging'); input.engine.grab(false, performance.now(), cancelled); capture.requestPresent();
      window.appearance.placement({ ...anchor, dragging: false });
      lastHit = undefined;
      capture.report();
    };
    const endDrag = () => { lastHit = undefined; finishDrag(true); };
    const onGeometry = (g: Geometry) => {
      if (disposed) return;
      if ((g.sequence ?? 0) < (current?.sequence ?? 0)) return;
      current = g; lastHit = undefined; capture.geometry(g);
      document.documentElement.dataset.fixedHost = String(!!g.fixedHost);
      if (!drag) {
        if (g.desktop) present(g.desktop.position);
        else { anchor = g.fixedHost ? g.anchor ?? { x: 0, y: 0 } : { x: 0, y: 0 }; element.style.transform = `translate3d(${anchor.x}px, ${anchor.y}px, 0)`; capture.positionChanged(); }
      }
    };
    const down = (e: PointerEvent) => {
      if (!current?.fixedHost || drag || e.button !== 0 || !(e.target instanceof Element) || !e.target.closest('.toolbar-grip')) return;
      e.preventDefault(); element.setPointerCapture(e.pointerId);
      const scale = current.desktop ? desktopGeometry(current.desktop, anchor).scale : 1;
      const point = current.desktop ? { x: current.desktop.host.x + e.clientX * devicePixelRatio, y: current.desktop.host.y + e.clientY * devicePixelRatio } : { x: e.clientX, y: e.clientY };
      drag = { id: e.pointerId, dx: (point.x - anchor.x) / scale, dy: (point.y - anchor.y) / scale };
      lastPlacement = 0; inputAges.length = 0; dragGaps.length = 0;
      input.engine.grab(true, performance.now()); capture.requestPresent();
      element.dataset.dragging = 'true'; window.appearance.placement({ ...anchor, dragging: true });
    };
    const move = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      const newest = e.getCoalescedEvents?.().at(-1) ?? e;
      const point = current?.desktop ? { x: current.desktop.host.x + newest.clientX * devicePixelRatio, y: current.desktop.host.y + newest.clientY * devicePixelRatio } : { x: newest.clientX, y: newest.clientY };
      const scale = current?.desktop ? nearestMonitor(point, current.desktop.monitors).scale : 1;
      pointerEvents++; pending = { x: point.x - drag.dx * scale, y: point.y - drag.dy * scale, at: newest.timeStamp };
      capture.requestPresent();
    };
    const up = (e: PointerEvent) => { if (drag?.id === e.pointerId) { move(e); finishDrag(false); } };
    element.addEventListener('pointerdown', down); element.addEventListener(moveEvent, move as EventListener);
    element.addEventListener('pointerup', up); element.addEventListener('pointercancel', endDrag); element.addEventListener('lostpointercapture', endDrag);
    window.addEventListener('blur', endDrag);
    const offGeometry = window.appearance.onGeometry(onGeometry);
    const applyConfig = (c: AppearanceState) => {
      if (disposed || c.revision < configRevision) return;
      configRevision = c.revision; setConfig(c);
      setMaterialNotice(c.failure);
      if (!motionConfig || JSON.stringify(motionConfig.motion) !== JSON.stringify(c.motion) || motionConfig.reduced !== c.reduced || motionConfig.visible !== c.visible) {
        if (!c.visible) { endDrag(); input.cancel(); }
        input.engine.configure(c.motion, c.reduced || matchMedia('(prefers-reduced-motion: reduce)').matches, c.visible, performance.now());
        if (!c.visible) input.sample(performance.now());
        if (c.visible) capture.requestPresent();
      }
      motionConfig = c;
      element.dataset.reading = String(c.mode === 'C' && c.material.adaptiveText && c.material.debugView === 'normal');
      setDebugLabel(c.mode === 'C' && c.enabled && c.visible && c.material.debugView !== 'normal' ? `诊断 · ${c.material.debugView === 'highlight' ? '高光分布' : '折射位移'}` : '');
      document.documentElement.dataset.reduced = String(c.reduced); document.documentElement.dataset.probeVisible = String(c.visible);
      if (c.reduced || !c.visible) element.getAnimations({ subtree: true }).forEach(a => a.cancel());
      void capture.configure(c);
    };
    const reducedPreference = matchMedia('(prefers-reduced-motion: reduce)');
    const onReduced = () => { if (motionConfig) { input.cancel(); input.engine.configure(motionConfig.motion, motionConfig.reduced || reducedPreference.matches, motionConfig.visible, performance.now()); capture.requestPresent(); } };
    reducedPreference.addEventListener('change', onReduced);
    const stopConfig = window.appearance.onConfig(applyConfig);
    const offConfig = () => { stopConfig(); stopReadingLayout(); foreground.dispose(); reducedPreference.removeEventListener('change', onReduced); element.getAnimations({ subtree: true }).forEach(a => a.cancel()); };
    const offDiagnostic = window.appearance.onDiagnostic(a => { if (a === 'lose-context') capture.loseContext(); else if (a.startsWith('preview-') && element.dataset.capture === 'live') input.previewMotion(a); });
    void window.appearance.geometry().then(g => { onGeometry(g); return window.appearance.config(); }).then(applyConfig);
    const syncHit = (freshPointer = false) => {
      if (drag) return;
      if (!current?.fixedHost) { if (freshPointer) window.appearance.pointer(); return; }
      const scale = current.desktop ? desktopGeometry(current.desktop, anchor).scale : 1;
      const point = cursor && current.desktop ? { x: current.desktop.host.x + cursor.x * devicePixelRatio, y: current.desktop.host.y + cursor.y * devicePixelRatio } : cursor;
      const menu = menuRef.current?.open ? menuRef.current.placement : null;
      const inside = !!point && (motionHit((point.x - anchor.x) / scale, (point.y - anchor.y) / scale, input.pose) || (!!menu && roundedMenuHit(point.x, point.y, menu.bounds, 16 * menu.scale)));
      if (freshPointer || inside !== lastHit) { lastHit = inside; window.appearance.pointer(inside); }
    };
    const pointer = (event: MouseEvent) => {
      cursor = event.type === 'mouseleave' ? null : { x: event.clientX, y: event.clientY };
      if (!drag && !pointerRaf) pointerRaf = requestAnimationFrame(() => { pointerRaf = 0; syncHit(true); });
    }; window.addEventListener('mousemove', pointer); window.addEventListener('mouseleave', pointer);
    const visibility = () => {
      if (document.hidden) { endDrag(); input.cancel(); input.engine.visible = false; input.engine.reset(); input.sample(performance.now()); capture.stop('窗口已隐藏，资源已释放'); }
      else if (motionConfig?.visible) {
        input.engine.configure(motionConfig.motion, motionConfig.reduced || reducedPreference.matches, true, performance.now());
        void capture.configure(motionConfig); // Reuse only this application's explicit material grant.
        capture.requestPresent();
      }
    }; document.addEventListener('visibilitychange', visibility);
    const unload = () => { disposed = true; endDrag(); input.dispose(); capture.stop(); element.getAnimations({ subtree: true }).forEach(a => a.cancel()); reducedPreference.removeEventListener('change', onReduced); }; window.addEventListener('beforeunload', unload);
    return () => { disposed = true; endDrag(); input.dispose(); motion.current = null; cancelAnimationFrame(pointerRaf); offGeometry(); offConfig(); offDiagnostic(); capture.stop(); window.removeEventListener('mousemove', pointer); window.removeEventListener('mouseleave', pointer); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('beforeunload', unload); window.removeEventListener('blur', endDrag); element.removeEventListener('pointerdown', down); element.removeEventListener(moveEvent, move as EventListener); element.removeEventListener('pointerup', up); element.removeEventListener('pointercancel', endDrag); element.removeEventListener('lostpointercapture', endDrag); };
  }, []);
  return <><div ref={shell} className={`capsule-shell ${active ? 'has-material' : ''} ${debugLabel && active ? 'diagnostic' : ''}`} title={`${status} · 右键外观调参`} data-presentation="pending" data-capture={active ? 'live' : 'off'} onContextMenu={event => { event.preventDefault(); window.appearance.contextMenu(); }}>
    <div className="material-host" ref={host} />
    {state && <LearningToolbar state={state} configured={presentation.configured} feedbackOpen={presentation.feedbackOpen} menuOpen={presentation.menuOpen} notice={historyStatus?.error || presentation.notice}
      nativeDrag onPrimary={intent => {
        if (intent === 'settings' || intent === 'picker') { void window.desktop.view(intent); return; }
        if (sending.current) return; sending.current = true;
        void window.desktop.act({ type: intent, revision: state.revision }).catch(() => window.desktop.view('operation-failed')).finally(() => { sending.current = false; });
      }} onView={view => { void window.desktop.view(view); }} />}
    {!active && <span className="material-fallback" role="status">{materialNotice || (status === '采集关闭' ? '材质已关闭 · 右键外观调参' : status)}</span>}
    {debugLabel && active && <span className="material-debug-label">{debugLabel}</span>}
  </div>{state && <LiquidMenu state={state} presentation={presentation} config={config} error={historyStatus?.error || presentation.notice} attach={attachMenu} wake={wakeMenu} />}</>;
}
