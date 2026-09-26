import { Glass } from '../../glass/glass';
import { REST_POSE } from '../../glass/motion';
import { ACCEPTED_MATERIAL } from '../../glass/presets';
import { DisplayStreams } from '../../glass/display-streams';
import { desktopGeometry, union, type DesktopMonitor } from '../../glass/desktop-layout';
import { ForegroundMask } from '../../glass/foreground-mask';
import type { AppearanceApi } from '../../glass/api';
import { MaterialCapture } from '../../glass/capture';
import { ACCEPTED_MOTION } from '../../glass/presets';
import type { Telemetry, Configuration } from '../../glass/contract';
const check = (v: unknown, message: string) => { if (!v) throw new Error(message); };
const delay = (n: number) => new Promise(r => setTimeout(r, n));
export async function verifyDisplaysGPU() {
  const originalApi = window.appearance, originalCapture = navigator.mediaDevices.getDisplayMedia;
  const monitors: DesktopMonitor[] = [
    { id: 'a', name: 'a', scale: 1, bounds: { x: -500, y: 0, width: 500, height: 500 }, pixels: { x: -500, y: 0, width: 500, height: 500 }, physical: { width: 500, height: 500 } },
    { id: 'b', name: 'b', scale: 2, bounds: { x: 0, y: 0, width: 500, height: 500 }, pixels: { x: 0, y: 0, width: 1000, height: 1000 }, physical: { width: 1000, height: 1000 } },
  ];
  const layout = { host: union(monitors.map(m => m.pixels)), position: { x: -160, y: 150 }, monitors };
  const canvases = monitors.map((m, i) => { const c = document.createElement('canvas'); c.width = m.physical.width; c.height = m.physical.height; const ctx = c.getContext('2d')!; ctx.fillStyle = i ? '#0000ff' : '#ff0000'; ctx.fillRect(0, 0, c.width, c.height); return c; });
  const material = { ...ACCEPTED_MATERIAL, blur: false, refraction: false, highlight: false, shade: false, contour: false, tint: false, shadow: false, adaptiveText: false, adaptiveFrost: false, fresnelStrength: 0 };
  const paintTimer = setInterval(() => canvases.forEach(c => c.getContext('2d')!.fillRect(0, 0, c.width, c.height)), 33);
  let request = '', count = 0; const streams: MediaStream[] = [];
  window.appearance = { prepareCapture: async id => { request = id; } } as AppearanceApi;
  navigator.mediaDevices.getDisplayMedia = async () => { count++; const stream = canvases[request === 'a' ? 0 : 1].captureStream(30); streams.push(stream); return stream; };
  let failure = ''; const pool = new DisplayStreams(() => {}, () => {}, text => { failure = text; });
  const g = desktopGeometry(layout);
  try {
    for (const dpr of [1, 1.25, 1.4, 1.5, 2, 3]) {
      const canvas = document.createElement('canvas'), glass = new Glass(canvas, dpr), gl = canvas.getContext('webgl2')!;
      try {
        const sources = canvases.map((c, i) => ({ video: c as unknown as HTMLVideoElement, display: monitors[i].pixels, frame: 1 }));
        glass.draw(sources[0].video, g, true, 'C', material, 1, true, true, REST_POSE, sources);
        const pixel = (x: number) => { const p = new Uint8Array(4); gl.readPixels(glass.contentPixels.x + Math.round(x * dpr), glass.contentPixels.y + Math.round(26 * dpr), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p); return p; };
        const left = pixel(120), right = pixel(200);
        check(left[0] > 240 && left[2] < 10 && right[2] > 240 && right[0] < 10, 'Multi-screen ROI seam at DPR ' + dpr + ': ' + left + ' / ' + right);
      } finally { glass.dispose(); }
    }
    pool.sync(desktopGeometry(layout, { x: 250, y: 150 }), 30); pool.sync(g, 30);
    for (let i = 0; i < 100 && !pool.sources(g); i++) await delay(30);
    check(count === 2 && pool.tracks === 2 && !!pool.sources(g), 'Cross-screen sources are not exactly two reusable streams: ' + JSON.stringify({ count, tracks: pool.tracks, sources: !!pool.sources(g), failure }));
    const one = desktopGeometry(layout, { x: 250, y: 150 }); pool.sync(one, 30); await delay(100);
    for (let i = 0; i < 200; i++) pool.sync(i % 2 ? one : g, 30);
    check(pool.tracks === 2 && count === 2 && pool.requests === 2 && streams.every(s => s.getTracks()[0].readyState === 'live'), 'Switching reacquired or released a prepared monitor');
    const coldPreparationEnd = performance.now() + 3000;
    check(pool.healthy(coldPreparationEnd), 'Bootstrap used steady-state timeout before renderer preparation');
    pool.renderingReady(coldPreparationEnd);
    check(pool.healthy(coldPreparationEnd + 2400) && !pool.healthy(coldPreparationEnd + 2600), 'Prewarm grace removed the normal stalled-source timeout');
    pool.stop(); check(pool.tracks === 0 && streams.every(s => s.getTracks().every(t => t.readyState === 'ended')), 'Pool stop leaked tracks');
    check(!failure, failure);
    let deliver: ((stream: MediaStream) => void) | undefined;
    navigator.mediaDevices.getDisplayMedia = () => new Promise(resolve => { deliver = resolve; });
    const late = new DisplayStreams(() => {}, () => {}, text => { failure = text; });
    late.sync(one, 30);
    for (let i = 0; i < 100 && !deliver; i++) await delay(10);
    check(deliver, 'Pending capture not requested'); late.stop();
    const arriving = canvases[1].captureStream(30); streams.push(arriving); deliver!(arriving); await delay(50);
    check(arriving.getTracks().every(t => t.readyState === 'ended') && late.tracks === 0 && !failure, 'Late capture result survived a stopped pool');
    const shell = document.createElement('div'), mask = new ForegroundMask(shell, () => {}, 1), atlas = mask.frame().canvas;
    mask.prepareDensities([1, 1.4, 2]); mask.density(2); const double = mask.frame().canvas; check(double.width === 642, 'DPI foreground atlas not prepared');
    mask.density(1); check(mask.frame().canvas === atlas, 'Switch rebuilt original atlas'); mask.density(2); check(mask.frame().canvas === double, 'Switch rebuilt second atlas'); mask.dispose();
    let latest: Telemetry | null = null, position = { x: -450, y: 100 };
    window.appearance = { prepareCapture: async id => { request = id; }, report: v => { latest = v; } } as AppearanceApi;
    navigator.mediaDevices.getDisplayMedia = async () => { const stream = canvases[request === 'a' ? 0 : 1].captureStream(30); streams.push(stream); return stream; };
    const host = document.createElement('div'); document.body.append(host);
    const capture = new MaterialCapture(host, () => {}, () => position);
    const config: Configuration = { displays: monitors, monitor: monitors[0], enabled: true, visible: true, fixedHost: true, mode: 'C', fps: 30, material: ACCEPTED_MATERIAL, materialRevision: 0, motion: ACCEPTED_MOTION, reduced: false };
    const report = () => { capture.report(); return latest! as Telemetry; };
    try {
      capture.geometry(desktopGeometry(layout, position)); await capture.configure(config);
      for (let i = 0; i < 100 && report().preparedRenderers !== 2; i++) await delay(30);
      check(report().preparedDisplays === 2 && report().preparedRenderers === 2, 'All screens/DPRs not warmed: ' + JSON.stringify(report()));
      const ready = report(), renderers = [...host.querySelectorAll('canvas')];
      for (let i = 0; i < 20; i++) { position = i % 2 ? { x: -450, y: 100 } : { x: 200, y: 150 }; capture.positionChanged(); capture.flushPresent(); await delay(20); check(report().liveTracks === 2 && report().preparedRenderers === 2, 'Switch temporarily dropped prepared resources'); }
      const after = report(); check(after.captureRequests === ready.captureRequests && after.rendererCreations === ready.rendererCreations && after.displaySwitches! >= 18 && renderers.every(c => c.isConnected), 'Cross-DPI switching rebuilt a stream/context: ' + JSON.stringify(after));
      await capture.configure({ ...config, visible: false }); check(report().liveTracks === 0 && report().preparedRenderers === 0 && !host.querySelector('canvas'), 'Hide leaked warm resources');
      await capture.configure(config); for (let i = 0; i < 100 && report().preparedRenderers !== 2; i++) await delay(30);
      capture.loseContext(); await delay(100); check(report().liveTracks === 0 && report().preparedRenderers === 0, 'Context loss leaked warm resources');
    } finally { capture.stop(); host.remove(); }
    return { seamDpr: [1, 1.25, 1.4, 1.5, 2, 3], syntheticPixelAssertions: 'red left, blue right', allStreamsPrepared: true, switchesWithoutReacquisition: 200, crossDpiWithoutRebuild: 20, atlasReuse: true, release: true, lateCaptureReleased: true, captureUsed: false, realDesktopPixelsRead: false };
  } finally { clearInterval(paintTimer); pool.stop(); streams.forEach(s => s.getTracks().forEach(t => t.stop())); window.appearance = originalApi; navigator.mediaDevices.getDisplayMedia = originalCapture; }
}
