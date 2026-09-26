import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { LearningToolbar } from '../../learning-surfaces';
import { makeSimulation } from './simulated';
import { SpatialInk } from '../../glass/spatial-ink';
import { ForegroundMask, type MaskFrame, type MaskSource } from '../../glass/foreground-mask';
import { SIZE } from '../../glass/contract';
import '../../glass/ui.css';

function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

async function verifyLocalGlyphCoverage(frame: MaskFrame) {
  const surface = document.createElement('canvas'); surface.width = surface.height = 1;
  const gl = surface.getContext('webgl2')!;
  const texture = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame.canvas);
  const program = gl.createProgram()!;
  for (const [kind, code] of [[gl.VERTEX_SHADER, '#version 300 es\nvoid main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.-1.,0,1);}'], [gl.FRAGMENT_SHADER, `#version 300 es
precision highp float;uniform sampler2D mask;uniform vec4 region;uniform vec2 size;out vec4 color;
void main(){bool ink=false,edge=false;for(int y=0;y<32;y++)for(int x=0;x<128;x++){
vec2 p=region.xy+region.zw*(vec2(x,y)+.5)/vec2(128.,32.);float a=texture(mask,p/size).a;
ink=ink||a>.3;edge=edge||(a>.03&&a<.97);}if(!ink||!edge)discard;color=vec4(0);}`]] as const) {
    const s = gl.createShader(kind)!; gl.shaderSource(s, code); gl.compileShader(s); check(gl.getShaderParameter(s, gl.COMPILE_STATUS), 'Glyph assertion compilation failed'); gl.attachShader(program, s); gl.deleteShader(s);
  }
  gl.linkProgram(program); check(gl.getProgramParameter(program, gl.LINK_STATUS), 'Glyph assertion link failed'); gl.useProgram(program);
  gl.uniform1i(gl.getUniformLocation(program, 'mask'), 0); gl.uniform2f(gl.getUniformLocation(program, 'size'), SIZE.width, SIZE.height);
  const queries = frame.groups.map(r => {
    gl.uniform4f(gl.getUniformLocation(program, 'region'), r.x, r.y, r.width, r.height);
    const q = gl.createQuery()!; gl.beginQuery(gl.ANY_SAMPLES_PASSED, q); gl.drawArrays(gl.TRIANGLES, 0, 3); gl.endQuery(gl.ANY_SAMPLES_PASSED); return q;
  });
  gl.flush(); const start = performance.now();
  while (!queries.every(q => gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) && performance.now() - start < 2000) await delay(5);
  queries.forEach((q, i) => { check(gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE) && gl.getQueryParameter(q, gl.QUERY_RESULT), `Actual DOM mask group ${i} lacks ink or antialiasing`); gl.deleteQuery(q); });
  check(gl.getError() === gl.NO_ERROR, 'DOM mask cannot upload to GPU');
  gl.deleteProgram(program); gl.deleteTexture(texture); gl.getExtension('WEBGL_lose_context')?.loseContext();
}

// GPU assertion helper: returns only an occlusion boolean, never image pixels.
function assertion(gl: WebGL2RenderingContext, width: number, height: number) {
  const texture = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  const p = gl.createProgram()!;
  for (const [kind, text] of [[gl.VERTEX_SHADER, '#version 300 es\nvoid main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.-1.,0,1);}'], [gl.FRAGMENT_SHADER, `#version 300 es
precision highp float;uniform sampler2D image;uniform vec2 at;uniform vec4 low,high;out vec4 color;
void main(){vec4 c=texture(image,at);if(any(lessThan(c,low))||any(greaterThan(c,high)))discard;color=vec4(0);}`]] as const) {
    const shader = gl.createShader(kind)!; gl.shaderSource(shader, text); gl.compileShader(shader); check(gl.getShaderParameter(shader, gl.COMPILE_STATUS), 'Assertion shader failed'); gl.attachShader(p, shader); gl.deleteShader(shader);
  }
  gl.linkProgram(p); check(gl.getProgramParameter(p, gl.LINK_STATUS), 'Assertion link failed');
  const vao = gl.createVertexArray()!;
  return {
    copy() { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texture); gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, width, height); },
    async pixel(x: number, y: number, low: number[], high: number[]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, 1, 1); gl.useProgram(p); gl.bindVertexArray(vao);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texture); gl.uniform1i(gl.getUniformLocation(p, 'image'), 0);
      gl.uniform2f(gl.getUniformLocation(p, 'at'), (x + .5) / width, (height - y - .5) / height);
      gl.uniform4fv(gl.getUniformLocation(p, 'low'), low); gl.uniform4fv(gl.getUniformLocation(p, 'high'), high);
      gl.colorMask(false, false, false, false); const q = gl.createQuery()!; gl.beginQuery(gl.ANY_SAMPLES_PASSED, q); gl.drawArrays(gl.TRIANGLES, 0, 3); gl.endQuery(gl.ANY_SAMPLES_PASSED); gl.colorMask(true, true, true, true); gl.flush();
      const start = performance.now(); while (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE) && performance.now() - start < 1500) await delay(5);
      check(gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE), 'Foreground query timeout'); const result = Boolean(gl.getQueryParameter(q, gl.QUERY_RESULT)); gl.deleteQuery(q); return result;
    },
    dispose() { gl.deleteTexture(texture); gl.deleteProgram(p); gl.deleteVertexArray(vao); },
  };
}

export async function verifySpatialInkGPU() {
  const canvas = document.createElement('canvas'); canvas.width = SIZE.width; canvas.height = SIZE.height;
  const gl = canvas.getContext('webgl2', { alpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true })!;
  check(gl, 'Foreground needs WebGL2');
  const glyph = document.createElement('canvas'); glyph.width = SIZE.width; glyph.height = SIZE.height;
  const c = glyph.getContext('2d')!; c.fillStyle = '#fff';
  const groups = Array.from({ length: 6 }, (_, i) => ({ x: 20, y: 3 + i * 8, width: 281, height: 5, scaleX: 1, scaleY: 1, dx: 0, dy: 0 }));
  groups.forEach(r => c.fillRect(r.x, r.y, r.width, r.height));
  const frame: MaskFrame = { canvas: glyph, groups, revision: 1, textRuns: 3, icons: 4, dots: 1, outlines: 1 };
  let visible = false; const source: MaskSource = { frame: () => frame, animating: false, visible: v => { visible = v; } };
  const ink = new SpatialInk(gl, canvas.width, canvas.height, source), query = assertion(gl, canvas.width, canvas.height);
  const paint = (reverse = false) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, canvas.width, canvas.height); gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(reverse ? 1 : 0, reverse ? 1 : 0, reverse ? 1 : 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.SCISSOR_TEST); gl.scissor(160, 0, 161, 52); gl.clearColor(reverse ? 0 : 1, reverse ? 0 : 1, reverse ? 0 : 1, 1); gl.clear(gl.COLOR_BUFFER_BIT); gl.disable(gl.SCISSOR_TEST);
    // Transparent output outside both the local mask and the synthetic surface.
    gl.enable(gl.SCISSOR_TEST); gl.scissor(0, 0, 10, 52); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); gl.disable(gl.SCISSOR_TEST);
  };
  try {
    paint(); ink.draw(true, false, true, 100); query.copy();
    for (const r of groups) {
      check(await query.pixel(40, r.y + 2, [.94, .94, .94, 1], [1, 1, 1, 1]), 'One of six glyph groups is not light on dark');
      check(await query.pixel(280, r.y + 2, [.06, .1, .16, 1], [.11, .15, .21, 1]), 'One of six glyph groups is not dark on light');
    }
    check(await query.pixel(5, 10, [0, 0, 0, 0], [0, 0, 0, 0]), 'Mask added a rectangular backing');
    check(await query.pixel(40, 1, [0, 0, 0, 1], [0, 0, 0, 1]), 'Mask changed background outside glyphs');
    // Repeat rendering does not re-rasterize or re-upload unchanged UI.
    paint(); ink.draw(true, false, true, 116); check(ink.report.maskUploads === 1, 'Unchanged mask uploaded per frame');
    paint(true); ink.draw(true, false, true, 132); query.copy();
    check(await query.pixel(40, 5, [.3, .3, .3, 1], [.9, .95, 1, 1]), 'Temporal color change has no intermediate value');
    paint(true); ink.draw(true, true, true, 148); query.copy();
    check(await query.pixel(40, 5, [.06, .1, .16, 1], [.11, .15, .21, 1]), 'Reduced motion still buffers colors');
    frame.revision++; groups[0].scaleX = .5; groups[0].scaleY = .5;
    paint(); ink.draw(true, true, true, 164); query.copy();
    check(await query.pixel(40, 5, [0, 0, 0, 1], [0, 0, 0, 1]), 'Pressed glyph did not follow group transform');
    check(Number(ink.report.maskUploads) === 2 && visible, 'Mask content update failed');
    groups[3].dy = -1.6; groups[3].scaleX = groups[3].scaleY = 1.06;
    paint(); ink.draw(true, true, false, 180); query.copy();
    check(await query.pixel(280, 26, [.06,.1,.16,1], [.11,.15,.21,1]), 'Feedback foreground did not rise with shared pose');
    check(await query.pixel(280, 31, [1,1,1,1], [1,1,1,1]), 'Feedback left a ghost at its old position');
    check(Number(ink.report.maskUploads) === 2, 'Feedback pose re-uploaded static atlas');
    groups[3].dy = -7; groups[3].scaleX = groups[3].scaleY = 1.3;
    paint(); ink.draw(true, true, false, 196); query.copy();
    check(await query.pixel(280, 20, [.06,.1,.16,1], [.11,.15,.21,1]), 'Strength 5 feedback foreground did not follow pose');
    check(await query.pixel(280, 31, [1,1,1,1], [1,1,1,1]), 'Strength 5 feedback left a ghost');
    check(Number(ink.report.maskUploads) === 2, 'Strength 5 pose re-uploaded atlas');
    check(gl.getError() === gl.NO_ERROR, 'Foreground corrupts GL state');
    ink.draw(false, false, false); check(!visible && !ink.animating, 'Disable leaves stale GPU foreground');
    ink.dispose(); check(!visible && !ink.animating, 'Dispose leaves GPU foreground active');
    return { sixGroupsSpatialAdaptation: 'pass', transparentOutside: 'pass', unchangedBackground: 'pass', maskUploads: 2, temporalAndReduced: 'pass', pressTransform: 'pass', release: 'pass', desktopCapture: false, pixelReadback: false, visualAcceptance: 'not evaluated' };
  } finally { ink.dispose(); query.dispose(); gl.getExtension('WEBGL_lose_context')?.loseContext(); }
}

export async function verifyForegroundDOM() {
  const element = document.createElement('div'); element.className = 'capsule-shell has-material'; element.dataset.reading = 'true'; document.body.append(element);
  const root = createRoot(element), { session } = makeSimulation(() => {}, 100);
  let wakes = 0; const source = new ForegroundMask(element, () => wakes++, 1.4);
  const states: Record<string, unknown> = {};
  const render = () => flushSync(() => root.render(<LearningToolbar state={session.snapshot()} onPrimary={() => {}} onView={() => {}} />));
  const inspect = async () => {
    const state = session.snapshot(); render(); await delay(25); const f = source.frame();
    check(f.groups.length === 6 && f.icons === 4 && f.dots === 1, `${state.phase}: icon/dot/grip omitted from mask`);
    check(f.textRuns === (state.phase === 'recording' ? 4 : 3), `${state.phase}: text/timer omitted from mask: ${f.textRuns}; DOM=${element.textContent}`);
    check(f.canvas.width === 449 && f.canvas.height === 73, 'Mask ignores actual DPR');
    const before = f.groups.map(g => [g.x, g.y, g.width, g.height]);
    element.style.transform = 'translate3d(350.5px,120.5px,0)';
    check(JSON.stringify(source.frame().groups.map(g => [g.x, g.y, g.width, g.height])) === JSON.stringify(before), 'Dragging changes local glyph positions');
    source.visible(true);
    check(getComputedStyle(element.querySelector('.toolbar-state strong')!).color === 'rgba(0, 0, 0, 0)', 'DOM text doubles GPU text');
    check(getComputedStyle(element.querySelector('.toolbar-more')!).pointerEvents !== 'none', 'Visual mask blocks React hit testing');
    await verifyLocalGlyphCoverage(f);
    states[state.phase] = { textRuns: f.textRuns, icons: f.icons, dots: f.dots, outlines: f.outlines, groups: before };
  };
  try {
    await session.select({ id: 'mask-test', kind: 'window', name: 'simulated' }); await inspect();
    await session.start(session.snapshot().revision); await inspect();
    const action = session.check(session.snapshot().revision);
    const started = performance.now(); while (session.snapshot().phase !== 'processing' && performance.now() - started < 1000) await delay(2);
    check(session.snapshot().phase === 'processing', 'Controller did not reach processing'); await inspect(); await action; await inspect();
    check(Object.keys(states).length === 4, 'Foreground missing simulated controller states');
    await delay(25); source.frame(); await delay(25); const revision = source.frame().revision;
    for (let i = 0; i < 4; i++) { await delay(20); check(source.frame().revision === revision, 'Unchanged mask keeps rebuilding'); }
    source.visible(false); check(getComputedStyle(element.querySelector('.toolbar-state strong')!).color !== 'rgba(0, 0, 0, 0)', 'Failure fallback leaves React invisible');
    source.dispose(); const count = wakes; render(); await delay(25); check(wakes === count, 'Disposed mask observer still runs');
    return { states, dpr: 1.4, glyphCoverageAndAntialiasing: 'all six actual DOM mask groups passed in four phases', stableMask: 'pass', hitTestingPreserved: 'pass', fallback: 'pass', observerRelease: 'pass', visualAcceptance: 'not evaluated' };
  } finally { source.dispose(); await session.quit(); root.unmount(); element.remove(); }
}
