import { AdaptiveInk, type InkTone } from '../../glass/adaptive-ink';
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
export async function verifyAdaptiveInkGPU() {
  const canvas = document.createElement('canvas'); canvas.width = 100; canvas.height = 40;
  const gl = canvas.getContext('webgl2', { antialias: false, depth: false, stencil: false })!;
  check(gl, 'Adaptive ink needs WebGL2');
  let callbacks = 0, tones: InkTone[] | null = null;
  const ink = new AdaptiveInk(gl, 100, 40, { width: 100, height: 40 }, value => { callbacks++; tones = value; });
  // Two rows verify DOM top-left -> GL bottom-left mapping as well as x mapping.
  const rects = [{ x: 0, y: 0, width: 20, height: 20 }, { x: 20, y: 20, width: 20, height: 20 }, { x: 40, y: 0, width: 20, height: 20 }, { x: 60, y: 20, width: 20, height: 20 }, { x: 80, y: 0, width: 20, height: 20 }];
  ink.layoutChanged(rects);
  let time = 0;
  const paint = (values: number[]) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.disable(gl.SCISSOR_TEST); gl.clearColor(.5, .5, .5, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.SCISSOR_TEST);
    rects.forEach((r, i) => { gl.scissor(r.x, 40 - r.y - r.height, r.width, r.height); gl.clearColor(values[i], values[i], values[i], 1); gl.clear(gl.COLOR_BUFFER_BIT); });
    gl.disable(gl.SCISSOR_TEST);
  };
  const sample = async (values: number[]) => {
    paint(values); const previous = ink.report.completed;
    ink.sample(true, time += 110);
    gl.flush(); // Hidden harness has no compositor frame to submit its commands.
    const start = performance.now();
    while (ink.report.completed === previous && performance.now() - start < 2000) await new Promise(resolve => setTimeout(resolve, 10));
    check(ink.report.completed > previous && !ink.report.error, 'Asynchronous GPU ink query did not complete: ' + JSON.stringify(ink.report) + '; GL=' + gl.getError());
    check(gl.getError() === gl.NO_ERROR, 'Ink query corrupted GL state');
    return [...(tones ?? [])];
  };
  try {
    const first = await sample([1, 0, 1, 0, 1]);
    check(first.join() === 'dark,light,dark,light,dark', 'Wrong foreground or coordinate mapping');
    const held = await sample([0, 1, 0, 1, 0]);
    check(held.join() === first.join(), 'Single transient frame changes foreground');
    const reversed = await sample([0, 1, 0, 1, 0]);
    check(reversed.join() === 'light,dark,light,dark,light', 'Sustained background change did not switch foreground');
    // sRGB .485 is approximately linear .20, inside both hysteresis thresholds.
    for (let i = 0; i < 4; i++) check((await sample([.485, .485, .485, .485, .485])).join() === reversed.join(), 'Midpoint noise caused polarity chatter');
    // Ensure the classifier did not alter the default framebuffer: query again
    // without painting. GPU-only classification must still see the same inputs.
    ink.sample(false); check(tones === null && !ink.report.pending, 'Disable leaves stale foreground/query');
    const unchanged = ink.report.completed;
    ink.sample(true, time += 110);
    gl.flush();
    const reenabledAt = performance.now();
    while (ink.report.completed === unchanged && performance.now() - reenabledAt < 2000) await new Promise(resolve => setTimeout(resolve, 10));
    check(ink.report.completed > unchanged, 'Re-enabled query timed out');
    paint([0, 0, 0, 0, 0]); ink.sample(true, time += 110);
    ink.dispose(); const disposedCallbacks = callbacks;
    await new Promise(resolve => setTimeout(resolve, 50));
    check(callbacks === disposedCallbacks && !ink.report.pending, 'Disposed classifier continues callbacks');
    return { first, held, reversed, completed: ink.report.completed, switches: ink.report.switches, coordinateMapping: 'pass', hysteresis: 'pass', transientSuppression: 'pass', disableAndDispose: 'pass', desktopCapture: false, pixelReadback: false, visualAcceptance: 'not evaluated' };
  } finally { ink.dispose(); }
}
