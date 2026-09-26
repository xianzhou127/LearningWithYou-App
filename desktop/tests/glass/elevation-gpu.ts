import accepted24 from '../../glass/presets/static-accepted24.json';
import { DEFAULT_MOTION, MotionEngine, REST_POSE, type MotionPose } from '../../glass/motion';
import { Glass } from '../../glass/glass';
import { patchMaterial, DEFAULT_MATERIAL, type MaterialSettings } from '../../glass/material-settings';
import { SIZE } from '../../glass/contract';
import type { MaskFrame, MaskSource } from '../../glass/foreground-mask';
import { pullOffset } from '../../glass/deformation';

function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Synthetic GPU-only assertions. Nothing captures or reads back desktop pixels.
export async function verifyElevationGPU() {
  const canvas = document.createElement('canvas'), input = document.createElement('canvas');
  input.width = 369; input.height = 100;
  const context = input.getContext('2d')!; context.fillStyle = '#808080'; context.fillRect(0, 0, 369, 100);
  const glyph = document.createElement('canvas'); glyph.width = 449; glyph.height = 73;
  const c = glyph.getContext('2d')!; c.scale(glyph.width / SIZE.width, glyph.height / SIZE.height); c.fillStyle = '#fff';
  const groups = Array.from({ length: 6 }, (_, i) => ({ x: 40 + 42 * i, y: 22, width: 10, height: 8, scaleX: 1, scaleY: 1, dx: 0, dy: 0 }));
  groups.forEach(r => c.fillRect(r.x, r.y, r.width, r.height));
  const frame: MaskFrame = { canvas: glyph, groups, revision: 1, textRuns: 3, icons: 4, dots: 1, outlines: 1 };
  let visible = false;
  const source: MaskSource = { frame: () => frame, animating: false, visible: value => { visible = value; } };
  const glass = new Glass(canvas, 1.4, () => {}, source), gl = canvas.getContext('webgl2')!;
  const rect = glass.contentPixels, textures: WebGLTexture[] = [], programs: WebGLProgram[] = [];
  const geometry = { window: { x: 24, y: 24, width: 321, height: 52 }, display: { x: 0, y: 0, width: 369, height: 100 }, scale: 1.4, valid: true };
  const base = { ...DEFAULT_MATERIAL, highlightStrength: 0, fresnelStrength: .5, adaptiveText: false, adaptiveFrost: false, screenLight: false, shadow: false, shade: false, contour: false, blur: false, tint: false, refraction: false };
  let revision = 0; let motion: MotionPose = REST_POSE;
  const render = (patch: Partial<MaterialSettings>, mode: 'B' | 'C' = 'C') => {
    glass.draw(input as unknown as HTMLVideoElement, geometry, true, mode, { ...base, ...patch }, ++revision, true, true, motion);
    const t = gl.createTexture()!; textures.push(t); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.copyTexImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 0, 0, canvas.width, canvas.height, 0);
    return t;
  };
  const vao = gl.createVertexArray()!;
  const assertGPU = async (name: string, a: WebGLTexture, b: WebGLTexture, predicate: string) => {
    const program = gl.createProgram()!; programs.push(program);
    for (const [kind, text] of [[gl.VERTEX_SHADER, '#version 300 es\nvoid main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.-1.,0,1);}'], [gl.FRAGMENT_SHADER, `#version 300 es
precision highp float;uniform sampler2D first,second;out vec4 color;
vec4 at(sampler2D t,vec2 p){return texture(t,(vec2(${rect.x}.,${rect.y}.)+vec2(p.x,52.-p.y)*1.4)/vec2(${canvas.width}.,${canvas.height}.));}
void main(){vec2 uv=gl_FragCoord.xy/vec2(${canvas.width}.,${canvas.height}.);vec4 a=texture(first,uv),b=texture(second,uv);
if(${predicate})discard;color=vec4(0);}`]] as const) {
      const shader = gl.createShader(kind)!; gl.shaderSource(shader, text); gl.compileShader(shader);
      check(gl.getShaderParameter(shader, gl.COMPILE_STATUS), name + ': ' + gl.getShaderInfoLog(shader)); gl.attachShader(program, shader); gl.deleteShader(shader);
    }
    gl.linkProgram(program); check(gl.getProgramParameter(program, gl.LINK_STATUS), name + ' link');
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, canvas.width, canvas.height); gl.useProgram(program); gl.bindVertexArray(vao);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, a); gl.uniform1i(gl.getUniformLocation(program, 'first'), 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, b); gl.uniform1i(gl.getUniformLocation(program, 'second'), 1);
    const q = gl.createQuery()!; gl.colorMask(false, false, false, false); gl.beginQuery(gl.ANY_SAMPLES_PASSED, q);
    gl.drawArrays(gl.TRIANGLES, 0, 3); gl.endQuery(gl.ANY_SAMPLES_PASSED); gl.colorMask(true, true, true, true); gl.flush();
    const start = performance.now();
    while (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE) && performance.now() - start < 2000) await delay(5);
    const ready = gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE), bad = ready && gl.getQueryParameter(q, gl.QUERY_RESULT); gl.deleteQuery(q);
    check(ready && !bad, name); check(gl.getError() === gl.NO_ERROR, name + ': GL state');
  };
  try {
    const narrow = render({ fresnelRange: 4, fresnelHardness: 0 });
    const wide = render({ fresnelRange: 12, fresnelHardness: 0 });
    const hard = render({ fresnelRange: 12, fresnelHardness: .8 });
    const zero = render({ fresnelStrength: 0 });
    await assertGPU('Range changes inward coverage', wide, narrow, 'at(first,vec2(160,10)).r>at(second,vec2(160,10)).r+.01');
    await assertGPU('Hardness fills the shoulder', hard, wide, 'at(first,vec2(160,12)).r>at(second,vec2(160,12)).r+.1');
    await assertGPU('Centre remains transmitted', hard, zero, 'abs(at(first,vec2(160,26)).r-at(second,vec2(160,26)).r)<.005');
    const legacy = render({ elevation: false, edgeWidth: 7 });
    const equivalent = render({ fresnelRange: 7, fresnelHardness: 0 });
    await assertGPU('Legacy Fresnel endpoint', legacy, equivalent, 'all(lessThan(abs(a-b),vec4(.005)))');
    const small = render({ highlight: false, shadow: true, shadowStrength: .3, shadowSpread: 1 });
    const soft = render({ highlight: false, shadow: true, shadowStrength: .3, shadowSpread: 8 });
    const faint = render({ highlight: false, shadow: true, shadowStrength: .1, shadowSpread: 8 });
    const none = render({ highlight: false, shadow: true, shadowStrength: 0, shadowSpread: 8 });
    await assertGPU('Shadow extends beyond old bounds', soft, small, 'at(first,vec2(160,-6)).a>at(second,vec2(160,-6)).a+.03');
    await assertGPU('Shadow strength independent from spread', soft, faint, 'at(first,vec2(160,-6)).a>at(second,vec2(160,-6)).a+.02');
    await assertGPU('Zero strength clears exterior', none, none, 'at(first,vec2(160,-6)).a==0.');
    for (const angle of [0, 90, 180, 270]) {
      const maximum = render({ highlight: false, shadow: true, shadowStrength: .4, shadowSpread: 10, lightAngle: angle });
      await assertGPU('Premultiplied alpha and maximum spread border ' + angle, maximum, maximum,
        'all(lessThanEqual(a.rgb,vec3(a.a+.001))) && ((gl_FragCoord.x>2. && gl_FragCoord.y>2. && gl_FragCoord.x<float(textureSize(first,0).x)-2. && gl_FragCoord.y<float(textureSize(first,0).y)-2.) || a.a==0.)');
    }
    for (const shape of [[1.01,.997,.18,0], [.997,1.01,0,-.18]] as [number,number,number,number][]) {
      motion = { ...REST_POSE, shape, gain: .16, elevation: 1, localLight: [.12,.12] };
      const maximum = render({ highlight: true, shadow: true, shadowStrength: .4, shadowSpread: 10 });
      await assertGPU('Motion maximum border/premultiplied ' + shape, maximum, maximum,
        'all(lessThanEqual(a.rgb,vec3(a.a+.001))) && ((gl_FragCoord.x>2. && gl_FragCoord.y>2. && gl_FragCoord.x<float(textureSize(first,0).x)-2. && gl_FragCoord.y<float(textureSize(first,0).y)-2.) || a.a==0.)');
    }
    for (const [x, y] of [[1000, 0], [-1000, 0], [0, 1000], [0, -1000], [1000, 1000]]) {
      const maximumEngine = new MotionEngine(); maximumEngine.configure({ ...DEFAULT_MOTION, strength: 5 }, false, true, 0);
      maximumEngine.setFocus(true, 0); maximumEngine.grab(true, 0); maximumEngine.velocity(x, y, 180); motion = maximumEngine.sample(230);
      for (const angle of [0, 90, 180, 270]) {
        const maximum = render({ highlight: true, shadow: true, shadowStrength: .4, shadowSpread: 10, lightAngle: angle });
        await assertGPU('Strength 5 border/premultiplied ' + [x, y, angle], maximum, maximum,
          'all(lessThanEqual(a.rgb,vec3(a.a+.001))) && ((gl_FragCoord.x>2. && gl_FragCoord.y>2. && gl_FragCoord.x<float(textureSize(first,0).x)-2. && gl_FragCoord.y<float(textureSize(first,0).y)-2.) || a.a==0.)');
      }
      maximumEngine.cancel(240); maximumEngine.setFocus(false, 240); motion = maximumEngine.sample(741);
      const returned = render({ fresnelRange: 4, fresnelHardness: 0 });
      await assertGPU('Strength 5 restores exact static pixels ' + [x, y], returned, narrow, 'all(equal(a,b))');
    }
    motion = REST_POSE;
    const restored = render({ fresnelRange: 4, fresnelHardness: 0 });
    await assertGPU('Motion restores exact static pixels', restored, narrow, 'all(equal(a,b))');
    const liquidMaterial = { highlightStrength: 1, fresnelStrength: 0, lightAngle: 90, shadow: false, adaptiveText: false };
    motion = REST_POSE; const liquidRest = render(liquidMaterial);
    motion = { ...REST_POSE, contact: [18, 26, 1], inflation: 8 }; const pressed = render(liquidMaterial);
    await assertGPU('Press inflates the bubble instead of flattening the contact', pressed, liquidRest,
      'at(first,vec2(18,7)).a>at(second,vec2(18,7)).a+.4 && all(equal(at(first,vec2(160,26)),at(second,vec2(160,26))))');
    motion = { ...REST_POSE, contact: [6, 26, 0], tug: [6.5, 0] }; const rightTug = render(liquidMaterial);
    motion = { ...REST_POSE, contact: [6, 26, 0], tug: [-6.5, 0] }; const leftTug = render(liquidMaterial);
    await assertGPU('Contacted left end extends left; remote right end does not grow', leftTug, rightTug,
      'at(first,vec2(2,26)).a>at(second,vec2(2,26)).a+.4 && abs(at(first,vec2(316,26)).a-at(second,vec2(316,26)).a)<.005');
    motion = { ...REST_POSE, tug: [0, 22] }; const upward = render(liquidMaterial);
    await assertGPU('Vertical pull bends both front and rear continuously', upward, liquidRest,
      'at(first,vec2(80,0)).a>.9 && at(first,vec2(180,0)).a>.9 && at(first,vec2(250,4)).a>.9 && at(second,vec2(180,0)).a==0.');
    motion = { ...REST_POSE, tug: [-31.9, 0] }; const lengthened = render(liquidMaterial);
    await assertGPU('Horizontal extension narrows both sides without moving the centreline', lengthened, liquidRest,
      'at(first,vec2(150,8)).a<.15 && at(first,vec2(150,44)).a<.15 && at(second,vec2(150,8)).a>.9 && at(second,vec2(150,44)).a>.9 && all(equal(at(first,vec2(160,26)),at(second,vec2(160,26))))');
    motion = { ...REST_POSE, tug: [4, 0] }; const shortened = render(liquidMaterial);
    // This sub-DIP expansion raises coverage at the old boundary. Sample the
    // boundary itself: an outside point can round to a pixel beyond both shapes.
    await assertGPU('Actual bounded inward compression widens both sides', shortened, liquidRest,
      'at(first,vec2(160,6)).a>at(second,vec2(160,6)).a+.15 && at(first,vec2(160,46)).a>at(second,vec2(160,46)).a+.15');
    motion = REST_POSE; const widthReturned = render(liquidMaterial);
    await assertGPU('Coupled transverse strain restores the exact static surface', widthReturned, liquidRest, 'all(equal(a,b))');
    motion = { ...REST_POSE, contact: [18, 26, 1], inflation: 8, energy: 1, lightField: [28, 1] }; const energized = render(liquidMaterial);
    await assertGPU('Stored bubble energy illuminates the interior from the contact', energized, pressed,
      'at(first,vec2(18,26)).r>at(second,vec2(18,26)).r+.005');
    motion = { ...motion, lightField: [28, 5] }; const strongerLight = render(liquidMaterial);
    await assertGPU('5x contact light increases actual interior brightness', strongerLight, energized,
      'at(first,vec2(18,26)).r>at(second,vec2(18,26)).r+.08 && all(lessThanEqual(a.rgb,vec3(a.a+.001)))');
    motion = { ...REST_POSE, contact: [160, 26, 0], ripple: [12, 1], lightField: [8, 1] }; const radial = render(liquidMaterial);
    await assertGPU('Contact wave brightens four equal-radius INTERIOR points', radial, liquidRest,
      'at(first,vec2(148,26)).r-at(second,vec2(148,26)).r>.14 && at(first,vec2(172,26)).r-at(second,vec2(172,26)).r>.14 && at(first,vec2(160,14)).r-at(second,vec2(160,14)).r>.14 && at(first,vec2(160,38)).r-at(second,vec2(160,38)).r>.14');
    await assertGPU('Radial gain is isotropic, independent of rim-facing masks', radial, liquidRest,
      'abs((at(first,vec2(148,26)).r-at(second,vec2(148,26)).r)-(at(first,vec2(160,14)).r-at(second,vec2(160,14)).r))<.02');
    motion = { ...REST_POSE, ripple: [62, 1], lightField: [12, 1] }; const waveNear = render(liquidMaterial);
    motion = { ...REST_POSE, ripple: [142, 1], lightField: [12, 1] }; const waveFar = render(liquidMaterial);
    await assertGPU('Contact wave travels along interior centreline', waveNear, waveFar,
      'at(first,vec2(80,26)).r>at(second,vec2(80,26)).r+.12 && at(second,vec2(160,26)).r>at(first,vec2(160,26)).r+.12');
    motion = { ...REST_POSE, ripple: [62, 1], lightField: [12, 0] }; const lightOff = render(liquidMaterial);
    await assertGPU('Contact light zero restores base without changing material', lightOff, liquidRest, 'all(equal(a,b))');
    motion = { ...REST_POSE, feedbackRing: [70, .5] }; const ringWide = render(liquidMaterial);
    motion = { ...REST_POSE, feedbackRing: [25, .5] }; const ringNarrow = render(liquidMaterial);
    await assertGPU('Feedback light converges towards the feedback icon', ringWide, ringNarrow,
      'at(first,vec2(195,6.5)).r>at(second,vec2(195,6.5)).r+.008 && at(second,vec2(249,6.5)).r>at(first,vec2(249,6.5)).r+.008');
    motion = { ...REST_POSE, elevation: -.575, gain: -.058, contact: [6, 8, .3], tug: [-.345, .345] };
    const recoil = render({ ...liquidMaterial, shadow: true, shadowSpread: 10, shadowStrength: .4 });
    await assertGPU('Rebound remains premultiplied with transparent output border', recoil, recoil,
      'all(lessThanEqual(a.rgb,vec3(a.a+.001))) && ((gl_FragCoord.x>2. && gl_FragCoord.y>2. && gl_FragCoord.x<float(textureSize(first,0).x)-2. && gl_FragCoord.y<float(textureSize(first,0).y)-2.) || a.a==0.)');
    motion = REST_POSE; const liquidReturned = render(liquidMaterial);
    await assertGPU('Liquid details return pixel-exactly to accepted rest', liquidReturned, liquidRest, 'all(equal(a,b))');
    // Local polarity must survive real composition, including the user's
    // static reflection. These are synthetic textures, never desktop readback.
    const polarityMaterial = { ...patchMaterial(DEFAULT_MATERIAL, accepted24.settings), adaptiveText: false };
    for (const [background, sign] of [['#161c24', 1], ['#fff', -1], ['#f0e8d0', -1]] as const) {
      context.fillStyle = background; context.fillRect(0, 0, 369, 100);
      motion = REST_POSE; const neutral = render(polarityMaterial);
      motion = { ...REST_POSE, contact: [160, 26, 0], ripple: [12, 1], lightField: [8, 1] };
      const wave = render(polarityMaterial);
      await assertGPU('Adaptive radial light has background-opposite polarity in four directions ' + background, wave, neutral,
        [[148, 26], [172, 26], [160, 14], [160, 38]].map(([x, y]) =>
          `(at(first,vec2(${x},${y})).r-at(second,vec2(${x},${y})).r)*${sign}.>.12`).join(' && '));
      // A full-energy wave can already hit the bounded light ceiling with
      // saved highlight strength 3; compare the unsaturated decay instead.
      motion = { ...motion, ripple: [12, .25] }; const fading = render(polarityMaterial);
      motion = { ...motion, lightField: [8, 5] }; const strong = render(polarityMaterial);
      await assertGPU('5x increases signed wave contrast and preserves alpha ' + background, strong, fading,
        `(at(first,vec2(148,26)).r-at(second,vec2(148,26)).r)*${sign}.>.08 && a.a==b.a && all(lessThanEqual(a.rgb,vec3(a.a+.001)))`);
      motion = { ...REST_POSE, energy: 1, contact: [160, 26, 0], lightField: [8, 5] }; const held = render(polarityMaterial);
      await assertGPU('Held contact uses the same adaptive polarity ' + background, held, neutral,
        `(at(first,vec2(160,26)).r-at(second,vec2(160,26)).r)*${sign}.>.15`);
      motion = { ...REST_POSE, feedbackRing: [25, .5] }; const feedback = render(polarityMaterial);
      await assertGPU('Feedback rim uses adaptive polarity ' + background, feedback, neutral,
        `(at(first,vec2(249,6.5)).r-at(second,vec2(249,6.5)).r)*${sign}.>.006`);
      motion = { ...REST_POSE, contact: [160, 26, 0], ripple: [12, 1], lightField: [8, 0] }; const disabledLight = render(polarityMaterial);
      await assertGPU('Zero light leaves no adaptive dark patch ' + background, disabledLight, neutral, 'all(equal(a,b))');
      motion = REST_POSE; const settled = render(polarityMaterial);
      await assertGPU('Settled adaptive light restores exact static pixels ' + background, settled, neutral, 'all(equal(a,b))');
    }
    context.fillStyle = '#161c24'; context.fillRect(0, 0, 369, 100);
    context.fillStyle = '#fff'; context.fillRect(185, 0, 184, 100);
    motion = REST_POSE; const splitRest = render(liquidMaterial);
    motion = { ...REST_POSE, contact: [160, 26, 0], ripple: [12, 1], lightField: [8, 1] }; const splitWave = render(liquidMaterial);
    await assertGPU('One radial wave brightens dark half and darkens bright half locally', splitWave, splitRest,
      'at(first,vec2(148,26)).r>at(second,vec2(148,26)).r+.14 && at(first,vec2(172,26)).r<at(second,vec2(172,26)).r-.14');
    // Sample adjacent 8-bit backgrounds across the whole adaptation band. An
    // abrupt polarity switch would fail even if both endpoint colors passed.
    for (const level of [140, 155, 170, 178, 185, 200, 216]) {
      context.fillStyle = `rgb(${level},${level},${level})`; context.fillRect(0, 0, 369, 100);
      const before = render(liquidMaterial);
      context.fillStyle = `rgb(${level + 1},${level + 1},${level + 1})`; context.fillRect(0, 0, 369, 100);
      const after = render(liquidMaterial);
      await assertGPU('Continuous polarity through neighboring grayscale ' + level, before, after, 'all(lessThan(abs(a-b),vec4(.025)))');
    }
    context.fillStyle = '#808080'; context.fillRect(0, 0, 369, 100);
    for (const pressure of [-1.4, 1.4]) for (const [tx, ty] of [[31.9, 0], [-31.9, 0], [0, 23.925], [0, -23.925]]) for (const angle of [0, 90, 180, 270]) {
      motion = { ...REST_POSE, contact: [18, 26, pressure], elevation: 2.25, inflation: pressure * 14, gain: .8, tug: [tx, ty], energy: 1.5, lightField: [72, 5], ripple: [360, 1] };
      const limit = render({ highlight: true, shadow: true, shadowStrength: .4, shadowSpread: 10, lightAngle: angle });
      await assertGPU('Elastic energy limit border/premultiplied ' + [pressure, tx, ty, angle], limit, limit,
        'all(lessThanEqual(a.rgb,vec3(a.a+.001))) && ((gl_FragCoord.x>2. && gl_FragCoord.y>2. && gl_FragCoord.x<float(textureSize(first,0).x)-2. && gl_FragCoord.y<float(textureSize(first,0).y)-2.) || a.a==0.)');
    }
    motion = REST_POSE;
    const b1 = render({ elevation: false }, 'B'), b2 = render({ shadowSpread: 10, fresnelHardness: 1, fresnelRange: 16 }, 'B');
    await assertGPU('B ignores new controls', b1, b2, 'all(equal(a,b))');
    // All six content groups compose in the original core viewport. Padding must
    // neither stretch the mask nor overwrite the expanded exterior shadow.
    // Use white here: #808080 is intentionally inside the continuous ink field's
    // transition band, so it must not be asserted as fully dark text.
    context.fillStyle = '#fff'; context.fillRect(0, 0, 369, 100);
    const ink = render({ highlight: false, shadow: true, shadowSpread: 8, shadowStrength: .3, adaptiveText: true });
    check(visible && glass.spatialSupport?.active, 'Foreground did not activate');
    for (const r of groups) await assertGPU('Foreground alignment ' + r.x, ink, ink,
      `at(first,vec2(${r.x + 5}.,26.)).r<.12 && at(first,vec2(${r.x + 5}.,26.)).b<.23 && at(first,vec2(${r.x + 5}.,26.)).a==1.`);
    await assertGPU('Foreground leaves exterior shadow untouched', ink, soft, 'abs(at(first,vec2(160,-6)).a-at(second,vec2(160,-6)).a)<.005');
    // Real saved material, bright/dark backgrounds. Assert output changes at
    // the actual rim, not only that a timeline/uniform contains nonzero numbers.
    const userMaterial = { ...patchMaterial(DEFAULT_MATERIAL, accepted24.settings), adaptiveText: false };
    for (const background of ['#fff', '#161c24']) {
      context.fillStyle = background; context.fillRect(0, 0, 369, 100);
      motion = REST_POSE; const rest = render(userMaterial);
      // These historical coverage coordinates target the strength-1 contour.
      // Strength 5 has already covered that pixel during focus; its complete
      // geometry/output limits are checked above at the actual maximum pose.
      const engine = new MotionEngine(); engine.configure({ ...DEFAULT_MOTION, strength: 1, liquid: false }, false, true, 0); engine.setFocus(true, 0); motion = engine.sample(140);
      const focus = render(userMaterial);
      await assertGPU('Saved material focus changes rim coverage ' + background, focus, rest, 'at(first,vec2(160,5.5)).a>at(second,vec2(160,5.5)).a+.08');
      engine.grab(true, 150); motion = engine.sample(370); const raised = render(userMaterial);
      await assertGPU('Saved material grip separates contour ' + background, raised, focus, 'at(first,vec2(160,4.8)).a>at(second,vec2(160,4.8)).a+.08');
      await assertGPU('Centre remains background-only during lift ' + background, raised, rest, 'all(lessThan(abs(at(first,vec2(160,26))-at(second,vec2(160,26))),vec4(.01)))');
      engine.grab(false, 400); engine.setFocus(false, 400); motion = engine.sample(651); const returned = render(userMaterial);
      await assertGPU('Saved material restores on release ' + background, returned, rest, 'all(equal(a,b))');
    }
    // Actual glyph paint outside the old 321x52 viewport: no clipping or ghost
    // at its old position; the padded field follows the background there too.
    const grip = groups[5]; grip.x = 9;
    c.clearRect(0, 0, SIZE.width, SIZE.height); groups.forEach(r => c.fillRect(r.x, r.y, r.width, r.height)); frame.revision++;
    motion = { ...REST_POSE, contact: [18, 26, 1], inflation: 8, tug: [-30, 20] };
    for (const g of groups) { const offset = pullOffset(g.x + g.width / 2, 18, motion.tug); g.dx = offset[0]; g.dy = offset[1]; }
    const movedGrip = [grip.x + 5 + grip.dx, grip.y + 4 + grip.dy];
    check(movedGrip[0] < 0, 'Extended glyph assertion must exercise outside core');
    for (const [background, lightInk] of [['#fff', false], ['#000', true]] as const) {
      context.fillStyle = background; context.fillRect(0, 0, 369, 100);
      const moved = render({ highlight: false, adaptiveText: true });
      await assertGPU('Moved grip outside core, correct field and no old ghost ' + background, moved, moved,
        `at(first,vec2(${movedGrip[0]},${movedGrip[1]})).r${lightInk ? '>.8' : '<.15'} && at(first,vec2(14,26)).r${lightInk ? '<.05' : '>.95'}`);
    }
    motion = REST_POSE;
    const shell = document.createElement('div'), host = document.createElement('div'); shell.className = 'capsule-shell'; host.className = 'material-host'; shell.append(host); host.append(canvas); document.body.append(shell);
    const old = document.documentElement.dataset.fixedHost; document.documentElement.dataset.fixedHost = 'true';
    try {
      const style = getComputedStyle(shell), box = canvas.getBoundingClientRect(), core = shell.getBoundingClientRect();
      check(style.overflow === 'visible' && !style.contain.includes('paint'), 'DOM clips exterior shadow');
      check(box.left < core.left - 31 && box.right > core.right + 31 && Math.abs(core.width - 321) < .05 && Math.abs(core.height - 52) < .05, 'Output padding changed content geometry: ' + JSON.stringify({ box: box.toJSON(), core: core.toJSON(), style: canvas.style.cssText }));
      check(getComputedStyle(canvas).pointerEvents === 'none', 'Exterior canvas takes input');
    } finally { shell.remove(); if (old === undefined) delete document.documentElement.dataset.fixedHost; else document.documentElement.dataset.fixedHost = old; }
    return { transverseCoupling: { extensionNarrows: 'pass', compressionWidens: 'pass at actual 4-DIP limit', centrelineAndStaticReturn: 'pass' }, adaptiveMotionLight: { darkBrightColoredBackgrounds: 'pass in four directions', heldAndFeedbackPolarity: 'pass', localMixedBackground: 'pass', neighboringGrayContinuity: 'pass', fiveTimesContrastAndPremultiplication: 'pass', zeroAndSettledExactReturn: 'pass' }, liquidDetails: { bubbleInflation: 'pass', contactedEndExtendsWithForce: 'pass', fullLengthVerticalBend: 'pass', movedGripOutsideCoreAndNoGhost: 'pass bright/dark', internalEnergyLight: 'pass', radialInteriorFourDirectionsAndTravel: 'pass', lightZero: 'pass', convergingFeedbackLight: 'pass', recoilBoundary: 'pass at light 5x', exactStaticReturn: 'pass' }, savedMaterialFocusGripCoverageAndRecovery: 'pass on synthetic white and dark', motionMaximumBoundsAndStaticReturn: 'pass', fresnelRangeAndStrengthAndHardness: 'pass', centrePreserved: 'pass', legacyEndpoint: 'pass', shadowSpreadAndStrength: 'pass', zeroStrength: 'pass', transparentMaximumBorderFourDirections: 'pass', premultipliedAlpha: 'pass', unchangedB: 'pass', sixForegroundGroupsDpr14: 'pass', domOverflowAndPointerPolicy: 'pass', outputPixels: [canvas.width, canvas.height], contentPixels: rect, desktopCapture: false, pixelReadback: false, visualAcceptance: 'not evaluated' };
  } finally { programs.forEach(p => gl.deleteProgram(p)); textures.forEach(t => gl.deleteTexture(t)); gl.deleteVertexArray(vao); glass.dispose(); check(!visible, 'Foreground remained after dispose'); }
}
