import { AdaptiveFrost, FROST_DECODE_GLSL, type FrostWeights } from '../../glass/adaptive-frost';
import { BLUR_FRAGMENT, Glass } from '../../glass/glass';
import { DEFAULT_MATERIAL } from '../../glass/material-settings';

function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
const vertex = '#version 300 es\nout vec2 uv;void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);uv=p;gl_Position=vec4(p*2.-1.,0,1);}';
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
export async function verifyAdaptiveFrostGPU() {
  const canvas = document.createElement('canvas'); canvas.width = 449; canvas.height = 180;
  const gl = canvas.getContext('webgl2', { antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true })!;
  check(gl, 'Frost needs WebGL2');
  const program = (fragment: string) => {
    const p = gl.createProgram()!;
    for (const [kind, code] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]] as const) {
      const shader = gl.createShader(kind)!; gl.shaderSource(shader, code); gl.compileShader(shader); check(gl.getShaderParameter(shader, gl.COMPILE_STATUS), String(gl.getShaderInfoLog(shader))); gl.attachShader(p, shader); gl.deleteShader(shader);
    }
    gl.linkProgram(p); check(gl.getProgramParameter(p, gl.LINK_STATUS), 'Frost test program failed'); return p;
  };
  const test = program(`#version 300 es
precision highp float;out vec4 color;uniform sampler2D image;uniform vec2 at,range;uniform bool packed,density;
${FROST_DECODE_GLSL}
void main(){vec4 c=texture(image,at);float v=packed?frostAmount(c):density?c.b:c.r;if(v<range.x||v>range.y)discard;color=vec4(0);}`);
  const blur = program(BLUR_FRAGMENT), vao = gl.createVertexArray()!;
  const input = gl.createTexture()!, output = gl.createTexture()!;
  for (const t of [input, output]) {
    gl.bindTexture(gl.TEXTURE_2D, t); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 449, 180, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  }
  const fb = gl.createFramebuffer()!; gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, output, 0);
  const frost = new AdaptiveFrost(gl);
  let now = 100;
  const paint = (kind: string, bandColumn?: number) => {
    // Synthetic test data only, never captured desktop content.
    const pixels = new Uint8Array(449 * 180 * 4);
    for (let y = 0; y < 180; y++) for (let x = 0; x < 449; x++) {
      const inBand = bandColumn === undefined || (x >= 64 + 18 + bandColumn * 285 / 48 && x < 64 + 18 + (bandColumn + 4) * 285 / 48);
      const i = (y * 449 + x) * 4, v = !inBand || kind === 'light' ? 255 : kind === 'dark' ? 0 : kind === 'gradient' ? Math.round(x / 448 * 255) : kind === 'split' ? (x < 224 ? 0 : 255) : Math.floor(x / (kind === 'wide' ? 12 : kind === 'fine' ? 1 : 4)) % 2 * 255;
      pixels[i] = v; pixels[i + 1] = kind === 'color' ? 255 - v : v; pixels[i + 2] = kind === 'color' ? 100 : v; pixels[i + 3] = 255;
    }
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, input); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 449, 180, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  };
  const draw = (reduced = false, changed = true, transitionMs = 400, regional = true, weights?: FrostWeights) => { now += 16; frost.draw(input, [449, 180], .8, 6, .12, reduced, changed, now, transitionMs, regional, weights); };
  const within = async (texture: WebGLTexture, min: number, max: number, packed = true, sampleX = 82.5, density = false) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, 1, 1); gl.bindVertexArray(vao); gl.useProgram(test);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texture); gl.uniform1i(gl.getUniformLocation(test, 'image'), 0); gl.uniform1i(gl.getUniformLocation(test, 'packed'), packed ? 1 : 0);
    gl.uniform1i(gl.getUniformLocation(test, 'density'), density ? 1 : 0);
    gl.uniform2f(gl.getUniformLocation(test, 'at'), packed ? .5 : sampleX / 449, packed ? .5 : 82.5 / 180); gl.uniform2f(gl.getUniformLocation(test, 'range'), min, max);
    const q = gl.createQuery()!; gl.beginQuery(gl.ANY_SAMPLES_PASSED, q); gl.drawArrays(gl.TRIANGLES, 0, 3); gl.endQuery(gl.ANY_SAMPLES_PASSED); gl.flush();
    const start = performance.now(); while (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE) && performance.now() - start < 2000) await delay(5);
    check(gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE), 'Frost assertion timeout'); const result = Boolean(gl.getQueryParameter(q, gl.QUERY_RESULT)); gl.deleteQuery(q); return result;
  };
  const blurFrame = (enabled: boolean, maximum = 3) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.viewport(0, 0, 449, 180); gl.bindVertexArray(vao); gl.useProgram(blur);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, input); gl.uniform1i(gl.getUniformLocation(blur, 'source'), 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, frost.texture); gl.uniform1i(gl.getUniformLocation(blur, 'frost'), 1);
    gl.uniform1i(gl.getUniformLocation(blur, 'adaptiveFrost'), enabled ? 1 : 0); gl.uniform1f(gl.getUniformLocation(blur, 'sigma'), .8); gl.uniform1f(gl.getUniformLocation(blur, 'maximumSigma'), maximum); gl.uniform2f(gl.getUniformLocation(blur, 'stepSize'), 1 / 449, 0); gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
  try {
    for (const kind of ['dark', 'light', 'gradient', 'split']) { paint(kind); draw(true); check(await within(frost.texture, 0, .005), `Simple ${kind} background incorrectly frosted`); }
    paint('dense'); draw(); check(await within(frost.texture, .04, .15), 'Frost attack must be gradual');
    for (let i = 0; i < 50; i++) draw(); check(await within(frost.texture, .98, 1), 'Dense texture failed to frost');
    blurFrame(false); check(await within(output, 0, .1, false), 'Disabled frost changed baseline blur');
    blurFrame(true); check(await within(output, .35, .65, false), 'Actual blur shader failed to remove dense stripes');
    blurFrame(true, .5); check(await within(output, 0, .1, false), 'Maximum below baseline reduced saved blur');
    paint('light'); draw(); check(await within(frost.texture, .89, .93), 'Frost release must match attack speed');
    for (let i = 0; i < 400; i++) draw(); check(await within(frost.texture, 0, .002), 'Frost remains stuck after smooth background');
    paint('color'); draw(true); check(await within(frost.texture, .98, 1), 'Colored detail or reduced motion failed');
    paint('wide'); draw(true);
    blurFrame(true, 3); check(await within(output, 0, .07, false, 78.5), 'Sigma 3 wide-stripe baseline changed');
    blurFrame(true, 6); check(await within(output, .15, .45, false, 78.5), 'Sigma 6 did not increase actual blur footprint');
    paint('fine'); draw(true); blurFrame(true, 6); check(await within(output, .45, .55, false), 'Strong blur aliases fine stripes');
    paint('light'); draw(false, true, 0); check(await within(frost.texture, 0, .005), 'Zero duration failed to clear immediately');
    paint('dense'); draw(false, true, 0); check(await within(frost.texture, .98, 1), 'Zero duration failed to frost immediately');
    const samples = frost.report.samples; draw(false, false); check(frost.report.samples === samples, 'Unchanged crop redundantly detected');
    // Equal-size detail bands move beneath status / primary / icons / blank.
    // Disjoint GPU-asserted intervals verify ordering without reading pixels.
    const weightedBands = [
      { name: 'status', col: 8, low: .13, high: .23 },
      { name: 'primary', col: 28, low: .065, high: .125 },
      { name: 'icons', col: 40, low: .015, high: .06 },
      { name: 'blank', col: 22, low: .001, high: .012 },
    ];
    for (const band of weightedBands) {
      paint('dense', band.col); draw(true);
      check(await within(frost.texture, band.low, band.high, false, .5, true), `Regional density ordering failed for ${band.name}`);
      draw(true, false, 400, false);
      // Neighbor support can include one extra grid column at a band boundary.
      check(await within(frost.texture, .075, .115, false, .5, true), `Equal-weight comparison differs by region: ${band.name}`);
    }
    paint('dense'); draw(true, true, 400, true, [0, 0, 0, 0]); check(await within(frost.texture, 0, .001), 'Zero weights caused nonzero/invalid blur');
    // Moving just the semantic layout must reweight the unchanged detail map.
    frost.layoutChanged([{ x: 148, y: 12, width: 24, height: 27 }, ...Array.from({ length: 4 }, () => ({ x: 0, y: 0, width: 1, height: 1 }))]);
    paint('dense', 22); draw(true); check(frost.report.regionSource === 'react' && await within(frost.texture, .98, 1), 'Updated DOM rectangle did not move high priority');
    frost.layoutChanged([]); draw(true, false); check(await within(frost.texture, .001, .012, false, .5, true), 'Fallback retained stale DOM weights');
    frost.stop(); check(!frost.report.active, 'Frost stop failed'); paint('light'); draw(); check(await within(frost.texture, 0, .005), 'Re-enable kept stale frost history');
    check(gl.getError() === gl.NO_ERROR, 'Frost caused GL error'); frost.dispose(); check(!frost.report.active, 'Disposed frost remains active');
    // Exercise actual crop -> detector -> two blur passes -> optics state binding,
    // at the user's DPR. A synthetic canvas is a valid texImage2D source; no video
    // capture is involved in this test-only substitution.
    const background = document.createElement('canvas'); background.width = 449; background.height = 180;
    const context = background.getContext('2d')!; context.fillStyle = '#fff'; context.fillRect(0, 0, 449, 180);
    context.fillStyle = '#000'; for (let x = 0; x < 449; x += 8) context.fillRect(x, 0, 4, 180);
    const target = document.createElement('canvas'), glass = new Glass(target, 1.4), actual = target.getContext('webgl2')!;
    const geometry = { window: { x: 64, y: 64, width: 321, height: 52 }, display: { x: 0, y: 0, width: 449, height: 180 }, scale: 1.4, valid: true };
    const settings = { ...DEFAULT_MATERIAL, adaptiveText: false, blurSigma: .8, frostSigma: 6, tintStrength: 0 };
    try {
      for (const mode of ['C', 'B', 'C'] as const) {
        glass.draw(background as unknown as HTMLVideoElement, geometry, true, mode, settings, 0, true);
        check(glass.frostSupport?.active === (mode === 'C'), 'Actual Glass mode failed to enable/disable frost');
        check(actual.getError() === actual.NO_ERROR, 'Actual Glass frost texture binding corrupted GL');
      }
      glass.draw(background as unknown as HTMLVideoElement, geometry, false, 'C', { ...settings, blur: false }, 1);
      check(!glass.frostSupport?.active, 'Blur master switch did not disable automatic frost');
      glass.draw(background as unknown as HTMLVideoElement, geometry, false, 'C', { ...settings, debugView: 'highlight' }, 2);
      check(!glass.frostSupport?.active, 'Diagnostic view unexpectedly frosted');
    } finally { glass.dispose(); }
    check(!glass.frostSupport?.active, 'Actual Glass failed to release frost');
    return { simpleAndGradientAndSingleEdge: 'pass', denseAndColoredTexture: 'pass', weightedRegions: weightedBands, equalWeightComparison: 'pass', changedLayoutAndFallback: 'pass', zeroWeights: 'pass', symmetricTransition: 'pass', restoredClearEndpoint: 'pass', actualBlurShader: 'pass', sigma6Footprint: 'pass', zeroDuration: 'pass', actualGlassDpr14AndModeSwitches: 'pass', baselineAndDisable: 'pass', reducedMotion: 'pass', stoppedAndReleased: 'pass', pixelReadback: false, desktopCapture: false, visualAcceptance: 'not evaluated' };
  } finally { frost.dispose(); [test, blur].forEach(p => gl.deleteProgram(p)); [input, output].forEach(t => gl.deleteTexture(t)); gl.deleteFramebuffer(fb); gl.deleteVertexArray(vao); gl.getExtension('WEBGL_lose_context')?.loseContext(); }
}
