import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { MoreMenu } from '../../learning-surfaces';
import { makeSimulation } from './simulated';
import { MenuMaterial } from '../../glass/menu-material';
import { ForegroundMask } from '../../glass/foreground-mask';
import { Glass } from '../../glass/glass';
import { ACCEPTED_MATERIAL, ACCEPTED_MOTION } from '../../glass/presets';
import { desktopGeometry } from '../../glass/desktop-layout';
import type { Configuration } from '../../glass/contract';
import '../../glass/menu.css';

const check = (v: unknown, message: string) => { if (!v) throw Error(message); };
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
export async function verifyMenuGPU() {
  const shell = document.createElement('div'); shell.className = 'liquid-menu'; shell.dataset.reading = 'true';
  Object.assign(shell.style, { width: '252px', height: '280px', animation: 'none' }); document.body.append(shell);
  const content = document.createElement('div'); shell.append(content); const root = createRoot(content);
  const { session } = makeSimulation(() => {}, 100); let actions = 0;
  flushSync(() => root.render(<MoreMenu state={session.snapshot()} onView={() => actions++} onAction={() => actions++} />));
  // The wrapper is a test-only React root; production places MoreMenu directly.
  Object.assign(content.style, { height: '100%' });
  await document.fonts.ready; await delay(30);
  const size = { width: 252, height: 280 };
  const nodes = () => Array.from(shell.querySelectorAll<HTMLElement>('header > strong, header > button, .menu-content > button, .menu-utilities > button, .menu-content > p'));
  const background = document.createElement('canvas'); background.width = background.height = 1000;
  const ctx = background.getContext('2d')!; ctx.fillStyle = '#eceff3'; ctx.fillRect(0, 0, 1000, 1000);
  const monitor = { id: 'menu', name: 'test', scale: 1, pixels: { x: 0, y: 0, width: 1000, height: 1000 }, bounds: { x: 0, y: 0, width: 1000, height: 1000 }, physical: { width: 1000, height: 1000 } };
  const base = desktopGeometry({ host: monitor.pixels, monitors: [monitor], position: { x: 100, y: 100 } });
  const g = { ...base, window: { x: 100, y: 100, ...size } };
  const sources = [{ video: background as unknown as HTMLVideoElement, display: monitor.pixels, frame: 1 }];
  try {
    for (const density of [1, 1.25, 1.4, 1.5, 2, 3]) {
      const mask = new ForegroundMask(shell, () => {}, density, size, nodes), frame = mask.frame();
      check(frame.groups.length === 9, 'Menu must rasterize all nine DOM groups');
      const local = frame.canvas.getContext('2d')!;
      for (const group of frame.groups) {
        const pixels = local.getImageData(Math.max(0, Math.floor(group.x * density)), Math.max(0, Math.floor(group.y * density)), Math.ceil(group.width * density), Math.ceil(group.height * density)).data;
        check(pixels.some((v, i) => i % 4 === 3 && v > 100), 'Menu glyph group is empty');
      }
      const canvas = document.createElement('canvas'), glass = new Glass(canvas, density, () => {}, mask, undefined, { ...size, radius: 16 });
      glass.setReadingRects(frame.groups.slice(0, 5));
      try {
        glass.draw(sources[0].video, g, true, 'C', ACCEPTED_MATERIAL, 17, false, true, undefined, sources);
        const gl = canvas.getContext('webgl2')!, pixel = new Uint8Array(4);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel); check(pixel[3] === 0, 'Panel paints rectangular allocation border');
        gl.readPixels(Math.round(canvas.width / 2), Math.round(canvas.height / 2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel); check(pixel[3] > 240, 'Panel centre missing');
        check(glass.spatialSupport?.active && glass.frostSupport?.active, 'Panel foreground/frost did not run');
        check(gl.getError() === gl.NO_ERROR, 'Panel GPU error');
      } finally { glass.dispose(); mask.dispose(); }
    }
    const material = new MenuMaterial(shell, { bounds: { x: 100, y: 100, ...size }, scale: 1, direction: 'down' }, () => {});
    const config: Configuration = { enabled: true, visible: true, fixedHost: true, reduced: false, fps: 30, mode: 'C', monitor, displays: [monitor], material: ACCEPTED_MATERIAL, materialRevision: 21, motion: ACCEPTED_MOTION };
    try {
      material.draw(g, sources, config); check(material.report.live, 'Menu renderer failed');
      check(material.report.alwaysFrosted && material.report.effectiveBlurSigma === 6 && !material.report.frost?.active, 'Default menu must stay highly blurred without adaptive reductions');
      material.draw(g, sources, { ...config, menuFrost: false });
      check(!material.report.alwaysFrosted && material.report.frost?.active, 'Opt-out must use the main adaptive frost');
      const button = shell.querySelector<HTMLButtonElement>('.menu-content > button')!;
      button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 180, clientY: 180 }));
      await delay(90); material.draw(g, sources, config);
      check(getComputedStyle(button).transform !== 'none', 'Menu accepted press did not reach foreground');
      window.dispatchEvent(new PointerEvent('pointerup')); material.draw(g, sources, { ...config, reduced: true });
      check(actions === 0, 'Visual preview dispatched an Action');
      const canvas = shell.querySelector('canvas')!; canvas.getContext('webgl2')!.getExtension('WEBGL_lose_context')!.loseContext();
      await delay(100); check(!material.report.live && material.report.failed, 'Menu context loss must release only menu');
      check(shell.querySelectorAll('button').length === 7, 'Fallback lost menu actions');
    } finally { material.dispose(); }
    return { densities: [1, 1.25, 1.4, 1.5, 2, 3], nineGlyphGroups: true, transparentAllocation: true, adaptiveFrostAndInk: true, contextLossFallback: true, visualActions: actions, source: 'synthetic canvas only; GPU readback contains no desktop pixels', visualAcceptance: 'pending user' };
  } finally { root.unmount(); shell.remove(); }
}
