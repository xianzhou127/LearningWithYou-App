import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { LearningToolbar } from '../../learning-surfaces';
import { makeSimulation } from './simulated';
import { MotionInput } from '../../glass/motion-input';
import { ForegroundMask } from '../../glass/foreground-mask';
import { MaterialCapture } from '../../glass/capture';
import { DEFAULT_MATERIAL } from '../../glass/material-settings';
import { DEFAULT_MOTION } from '../../glass/motion';
import type { Telemetry, Configuration } from '../../glass/contract';
import type { AppearanceApi } from '../../glass/api';
import '../../glass/ui.css';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function check(v: unknown, message: string): asserts v { if (!v) throw new Error(message); }
export async function verifyMotionDOM() {
  const shell = document.createElement('div'); shell.className = 'capsule-shell has-material'; shell.dataset.reading = 'true';
  document.body.append(shell); const root = createRoot(shell);
  const { session, counts } = makeSimulation(() => {}, 100);
  let views = 0, wakes = 0;
  const render = () => {
    const state = session.snapshot();
    flushSync(() => root.render(<LearningToolbar state={state} nativeDrag onPrimary={intent => {
      if (intent === 'start') void session.start(state.revision);
      if (intent === 'check') void session.check(state.revision);
    }} onView={() => { views++; }} />));
    if (input) input.engine.snapshot(state, performance.now());
  };
  await session.select({ id: 'synthetic', name: 'simulation', kind: 'window' });
  const input = new MotionInput(shell, () => { wakes++; });
  render();
  const source = new ForegroundMask(shell, () => {}, 1.4); source.motion = () => input.pose;
  const off = session.subscribe(render);
  const node = (selector: string) => shell.querySelector<HTMLButtonElement>(selector)!;
  const pointer = (target: EventTarget, type: string, id = 1, outside = false, pointerType = 'mouse') => {
    const r = target instanceof Element ? target.getBoundingClientRect() : shell.getBoundingClientRect();
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: id, isPrimary: true, pointerType, button: 0, clientX: outside ? -100 : r.x + r.width / 2, clientY: outside ? -100 : r.y + r.height / 2 }));
  };
  try {
    const grip = node('.toolbar-grip'), shellBox = shell.getBoundingClientRect();
    grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 8, button: 0, clientX: shellBox.x + 12, clientY: shellBox.y + 18 }));
    input.engine.grab(true, performance.now()); await delay(80); input.sample(performance.now());
    check(input.pose.contact[0] === 12 && input.pose.contact[1] === 18 && input.pose.contact[2] > .3 && input.pose.energy > 0 && input.pose.ripple[1] > 0, 'Actual grip pointer origin was not mapped to shell DIP');
    input.engine.velocity(-900, -500, performance.now()); await delay(55); input.sample(performance.now());
    const pulledFrame = source.frame();
    for (const [i, selector] of ['.toolbar-state', '.toolbar-context', '.learning-primary', '.toolbar-feedback', '.toolbar-more', '.toolbar-grip'].entries()) {
      const transform = new DOMMatrixReadOnly(getComputedStyle(node(selector)).transform);
      check(Math.abs(transform.e - input.pose.offsetsX[i]) < .001 && Math.abs(transform.f - input.pose.offsetsY[i]) < .001, 'Pulled DOM translation differs from pose: ' + selector);
      check(pulledFrame.groups[i].dx === input.pose.offsetsX[i] && pulledFrame.groups[i].dy === input.pose.offsetsY[i], 'Pulled GPU mask differs from DOM: ' + selector);
    }
    check(input.pose.offsetsX[5] < input.pose.offsetsX[0] && input.pose.offsetsX[0] < input.pose.offsetsX[2], 'Grip did not separate from following content');
    pointer(grip, 'pointercancel', 8); input.sample(performance.now() + 510);
    check(Number(input.pose.contact[2]) === 0 && input.pose.ripple[1] === 0 && input.pose.tug.every(v => v === 0), 'Cancelled contact left liquid details active');
    input.engine.reset(); // Previous cancellation probe sampled a future timestamp.
    input.engine.configure(DEFAULT_MOTION, false, true, performance.now());
    const more = node('.toolbar-more');
    pointer(more, 'pointerdown'); await delay(70); input.sample(performance.now());
    let frame = source.frame(); const scale = new DOMMatrixReadOnly(getComputedStyle(more).transform).a;
    check(Math.abs(scale - .85) < .0001 && Math.abs(frame.groups[4].scaleX - scale) < .0001, 'GPU/DOM press alignment');
    const uploads = frame.revision; input.sample(performance.now() + 10); frame = source.frame(); check(frame.revision === uploads, 'Animation rebuilt glyph atlas');
    pointer(window, 'pointermove', 1, true); pointer(more, 'pointerup', 1, true);
    more.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })); check(views === 0, 'Drag-out produced a click');
    for (const cancel of ['pointercancel', 'lostpointercapture']) {
      pointer(more, 'pointerdown', 2, false, 'touch'); pointer(more, cancel, 2, false, 'touch');
      more.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
      input.sample(performance.now() + 250); check(Number(input.pose.scales[4]) === 1 && views === 0, cancel + ' did not recover');
    }
    const feedback = node('.toolbar-feedback'); pointer(feedback, 'pointerdown'); input.sample(performance.now() + 80); check(input.pose.scales[3] === 1, 'Disabled button reacted');
    more.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: ' ' })); input.sample(performance.now() + 65); check(Number(input.pose.scales[4]) === .85, 'Keyboard press missing');
    const repeated = new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', repeat: true, cancelable: true }); more.dispatchEvent(repeated); check(repeated.defaultPrevented, 'Enter repeat not suppressed');
    more.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); input.sample(performance.now() + 220); check(Number(input.pose.scales[4]) === 1, 'Keyboard focusout stuck');
    pointer(more, 'pointerdown'); window.dispatchEvent(new Event('blur')); input.sample(performance.now() + 260); check(Number(input.pose.scales[4]) === 1, 'Window blur stuck');
    // Mouse and native keyboard activation still go through the real React handler.
    const primary = node('.learning-primary'); for (let i = 0; i < 12; i++) primary.click();
    await delay(20); check(counts.start === 1 && session.snapshot().recording, 'Rapid React clicks started multiple sessions');
    node('.learning-primary').click(); await delay(160); check(session.snapshot().phase === 'feedback', 'Real controller flow failed');
    input.sample(performance.now() + 100);
    const feedbackTransform = new DOMMatrixReadOnly(getComputedStyle(node('.toolbar-feedback')).transform);
    const feedbackFrame = source.frame();
    check(feedbackTransform.f < -.5 && Math.abs(feedbackTransform.f - feedbackFrame.groups[3].dy) < .001, 'Feedback GPU/DOM vertical motion misaligned');
    const notices = input.engine.notifications; render(); window.dispatchEvent(new Event('focus')); render(); check(input.engine.notifications === notices && notices === 1, 'Feedback repeated after render/focus');
    const highStart = performance.now(); input.engine.configure({ ...DEFAULT_MOTION, strength: 5 }, false, true, highStart);
    input.engine.snapshot({ phase: 'feedback', sessionId: 999, roundId: 1, feedback: 'simulated geometry check' }, highStart);
    input.sample(highStart + 180); const highFrame = source.frame();
    const highTransform = new DOMMatrixReadOnly(getComputedStyle(node('.toolbar-feedback')).transform);
    check(Math.abs(highTransform.a - 1.3) < .0001 && Math.abs(highTransform.f + 7) < .001 && highFrame.groups[3].dy === -7, 'Strength 5 GPU/DOM pose differs');
    for (const g of highFrame.groups) {
      const cy = g.y + g.height / 2 + g.dy;
      check(cy - g.height * g.scaleY / 2 >= .5 && cy + g.height * g.scaleY / 2 <= 51.5, 'Strength 5 foreground clips viewport');
    }
    input.engine.configure(DEFAULT_MOTION, true, true, performance.now()); pointer(more, 'pointerdown'); input.sample(performance.now());
    check(Number(input.pose.scales[4]) === .85 && !input.pose.active, 'Reduced press is not immediate'); pointer(more, 'pointerup');
    input.engine.configure(DEFAULT_MOTION, false, false, performance.now()); input.sample(performance.now()); check(!input.pose.active, 'Hidden motion remains active');
    source.visible(true); source.visible(false); check(getComputedStyle(node('.learning-primary')).color !== 'rgba(0, 0, 0, 0)', 'Failure fallback invisible');
    input.dispose(); const before = wakes; pointer(more, 'pointerdown'); check(wakes === before, 'Disposed input listener still wakes');
    return { contactOriginAndCancel: 'actual pointer coordinates mapped to shell DIP; pass', pressAlignment: 'six-group shared pose; DOM primary/more exercised', dragOut: 'pass', pointerCancel: 'pass', lostCapture: 'pass', touch: 'synthetic event semantics only', keyboard: 'pass', disabled: 'pass', blur: 'pass', rapidReactActions: counts.start, feedbackOnce: notices, reduced: 'pass', release: 'pass' };
  } finally { input.dispose(); source.dispose(); off(); await session.quit(); root.unmount(); shell.remove(); }
}

export async function verifyCaptureLifecycle() {
  const host = document.createElement('div'); document.body.append(host);
  const background = document.createElement('canvas'); background.width = 369; background.height = 100;
  const ctx = background.getContext('2d')!; const paint = () => { ctx.fillStyle = '#888'; ctx.fillRect(0, 0, 369, 100); }; paint();
  const original = navigator.mediaDevices.getDisplayMedia, originalApi = window.appearance;
  let latest: Telemetry | null = null; const tracks: MediaStreamTrack[] = [];
  window.appearance = { report: (v: Telemetry) => { latest = v; } } as AppearanceApi;
  navigator.mediaDevices.getDisplayMedia = async () => { const stream = background.captureStream(30); tracks.push(...stream.getTracks()); return stream; };
  const paintTimer = setInterval(paint, 30);
  const capture = new MaterialCapture(host, () => {});
  const config: Configuration = { mode: 'C', fps: 30, enabled: true, visible: true, fixedHost: true, reduced: false, material: DEFAULT_MATERIAL, materialRevision: 0, motion: DEFAULT_MOTION, monitor: { id: 'synthetic', name: 'Synthetic canvas, not desktop capture', bounds: { x: 0, y: 0, width: 369, height: 100 }, physical: { width: 369, height: 100 }, scale: 1 } };
  // This probe uses only a synthetic Canvas stream, never an actual screen.
  capture.geometry({ window: { x: 24, y: 24, width: 321, height: 52 }, display: config.monitor!.bounds, clientOffset: { x: 24, y: 24 }, valid: true, scale: 1, fixedHost: true });
  const report = () => { capture.report(); return latest! as Telemetry; };
  try {
    await capture.configure(config); await delay(350); check(report().liveTracks === 1 && report().renderFrames > 0, 'Synthetic stream did not render: ' + JSON.stringify(report()));
    const beforeBlur = report().captureFrames; window.dispatchEvent(new Event('blur')); await delay(140); check(report().captureFrames > beforeBlur, 'Blur stopped background updates');
    await capture.configure({ ...config, visible: false, enabled: false }); const hidden = report(); await delay(150);
    check(hidden.gl === 'released' && hidden.liveTracks === 0 && report().renderFrames === hidden.renderFrames && host.querySelector('canvas') === null, 'Hidden capture resources/scheduling not released');
    await capture.configure(config); await delay(180); capture.loseContext(); await delay(100); check(report().gl === 'released' && report().liveTracks === 0, 'Context loss did not clear stream/material');
    // A stream that resolves after hide must be stopped without constructing GL.
    let resolve!: (stream: MediaStream) => void;
    navigator.mediaDevices.getDisplayMedia = () => new Promise<MediaStream>(r => { resolve = r; });
    let captureRequests = 0;
    navigator.mediaDevices.getDisplayMedia = () => { captureRequests++; return new Promise<MediaStream>(r => { resolve = r; }); };
    const pending = capture.configure(config);
    await capture.configure({ ...config, materialRevision: 1, material: { ...config.material, shadowStrength: .22 } });
    await capture.configure({ ...config, motion: { ...config.motion, light: 2.5 } });
    check(captureRequests === 1, 'Live tuning duplicated an unresolved capture request');
    capture.stop(); const late = background.captureStream(30); resolve(late); await pending;
    check(late.getTracks().every(t => t.readyState === 'ended') && report().gl === 'released', 'Late capture callback resurrected hidden resources');
    // A failed constraint reply from an old stream must not stop its replacement.
    navigator.mediaDevices.getDisplayMedia = async () => { const stream = background.captureStream(30); tracks.push(...stream.getTracks()); return stream; };
    await capture.configure(config); const oldTrack = tracks.at(-1)!;
    let rejectConstraint!: (reason: Error) => void;
    oldTrack.applyConstraints = () => new Promise<void>((_resolve, reject) => { rejectConstraint = reject; });
    const changing = capture.configure({ ...config, fps: 60 });
    await capture.configure({ ...config, visible: false }); await capture.configure(config);
    rejectConstraint(new Error('stale constraint result')); await changing;
    check(report().liveTracks === 1, 'A late old constraint failure stopped a replacement stream');
    return { input: 'synthetic canvas stream only', blurRefresh: 'pass', hidden: 'GL released, no extra draw', contextLoss: 'pass', pendingTune: 'one request', staleConstraints: 'replacement survives', lateCallback: 'pass', captureUsed: false };
  } finally { capture.stop(); clearInterval(paintTimer); tracks.forEach(t => t.stop()); navigator.mediaDevices.getDisplayMedia = original; window.appearance = originalApi; host.remove(); }
}
