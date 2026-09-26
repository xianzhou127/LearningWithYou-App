import { verifyMenuGPU } from './menu-gpu';
import { verifyMotionDOM, verifyCaptureLifecycle } from './motion-dom';
import { DISTANCE_LIGHT_GLSL } from '../../glass/distance-light';
import { Glass } from '../../glass/glass';
import { verifyAdaptiveInkGPU } from './adaptive-ink-gpu';
import { verifySpatialInkGPU, verifyForegroundDOM } from './spatial-ink-gpu';
import { verifyReadingDOM } from './readability-dom';
import { verifyAdaptiveFrostGPU } from './adaptive-frost-gpu';
import { verifyElevationGPU } from './elevation-gpu';
import { verifyDisplaysGPU } from './displays-gpu';

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function run() {
  // Compile/link the actual production fragment programs without capture.
  const material = new Glass(document.createElement('canvas'), 1);
  const renderer = material.renderer; material.dispose();
  const gl = document.createElement('canvas').getContext('webgl2');
  check(gl, 'WebGL2 unavailable');
  const program = gl.createProgram()!;
  const vertex = `#version 300 es
precision highp float;
in vec4 a; in vec4 b; in vec4 c; in vec4 d; in vec4 e;
out vec4 result;
${DISTANCE_LIGHT_GLSL}
void main(){
  vec4 cap=convexCap(a.xy,a.z,a.w);
  float value=d.y>.5
    ? sphereReflection(a.xyz,b.xyz,b.w,d.z,c.y,c.x)
    : distanceReflection(a.xy,a.z,a.w,b.xyz,b.w,c.x,c.y,c.z,d.x,c.w);
  result=d.y>1.5 ? vec4(linearToSrgb(srgbToLinear(a.xyz)),1.) : vec4(value,cap.z,cap.w,0.);
  if(d.y>2.5){
    vec4 lens=planoCap(e.xy,a.xy,a.z,a.w);
    vec2 interfaces=planoReflection(e.xy,a.xy,a.z,a.w,b.xyz,b.w,c.x,c.y,c.z,d.x,c.w);
    result=vec4(interfaces,abs(lens.x),lens.w);
  }
  if(d.y>3.5){
    float support=centreRimSupport(b.xy,c.x,a.z,a.w,d.z,d.x,c.y);
    vec3 mixed=balanceReflectedColor(vec3(.1),srgbToLinear(vec3(.8)),vec3(1.),d.x,support);
    result=vec4(support,mixed.r,0.,0.);
  }
  gl_Position=vec4(0.,0.,0.,1.); gl_PointSize=1.;
}`;
  for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, '#version 300 es\nprecision highp float;out vec4 color;void main(){color=vec4(0.);}']] as const) {
    const shader = gl.createShader(type)!; gl.shaderSource(shader, source); gl.compileShader(shader);
    check(gl.getShaderParameter(shader, gl.COMPILE_STATUS), String(gl.getShaderInfoLog(shader)));
    gl.attachShader(program, shader); gl.deleteShader(shader);
  }
  gl.transformFeedbackVaryings(program, ['result'], gl.INTERLEAVED_ATTRIBS); gl.linkProgram(program);
  check(gl.getProgramParameter(program, gl.LINK_STATUS), String(gl.getProgramInfoLog(program)));
  const cases: number[][] = [];
  const add = (a: number[], b: number[], c: number[], d = [1, 0, .14, 0], e = [0, 0, 0, 0]) => { cases.push([...a, ...b, ...c, ...d, ...e]); return cases.length - 1; };
  const falloff = [1, 2, 4].map(r => add([0, 0, 1, 2.45], [0, 0, 450 * r, 126], [450, 1.42, 2, .8], [0, 1, .14, 0]));
  const profiles = [.05, .5].map(r => Array.from({ length: 121 }, (_, i) => {
    const angle = (i - 60) * Math.PI / 180;
    return add([Math.sin(angle), 0, Math.cos(angle), 2.45], [0, 0, 450, 450 * r], [450, 1.42, 2, .8], [0, 1, .14, 0]);
  }));
  const centre = [-.001, 0, .001].map(x => add([1, 0, 18, 2.45], [x, 0, 450, 126], [450, 1.42, 2, .8]));
  const symmetry = [-1, 1].map(sign => add([sign, 0, 10, 2.45], [300 * sign, 0, 450, 126], [450, 1.42, 2, .8]));
  const noInterface = add([0, 0, 1, 2.45], [100, 0, 450, 126], [450, 1, 2, .8], [0, 1, .14, 0]);
  const colors = [0, .003, .04, .2, .5, 1].map(v => ({ v, id: add([v, v, v, 1], [0, 0, 450, 126], [450, 1.42, 2, .8], [0, 2, .14, 0]) }));
  for (const height of [80, 1200]) for (const radius of [.05, .65]) for (const x of [-1500, -.001, 0, .001, 1500]) {
    for (const depth of [0, .001, .5, 2, 10, 20]) for (const ior of [1, 1.42, 1.65]) {
      add([1, 0, depth, 6], [x, 0, height, height * radius], [height, ior, .35, 1]);
    }
  }
  const point = (x: number, y: number) => {
    const rx = x - Math.max(-134.5, Math.min(134.5, x)), r = Math.hypot(rx, y);
    return [r ? rx / r : 0, r ? y / r : 0, 20 - r, 2.45];
  };
  const lens = (x: number, y: number, lx: number, ly: number, radius = 23.1525, mode = 3, ior = 1.42, balance = .8) =>
    add(point(x, y), [lx - x, ly - y, 463.05, radius], [463.05, ior, 3.3, balance], [1, mode, .14, 0], [x, y, 0, 0]);
  const longitudinal = [-100, 0, 100].map(x => lens(x, 10, 0, 0));
  const planoCentre = [-.001, 0, .001].map(x => lens(0, 0, x, 0));
  const planeBudget = lens(0, 0, 0, 0, 300, 3, 1.42, 0);
  const lensNoInterface = lens(0, 0, 0, 0, 100, 3, 1, 0);
  const planoFalloff = [1, 2, 4].map(r => add([0, 0, 20, 2.45], [0, 0, 463.05 * r, 23.1525], [463.05, 1.42, 3.3, .8], [1, 3, .14, 0]));
  const capShoulders = [-154.4, 154.4].map(x => lens(x, 0, 0, 0));
  const centreSupport = (x: number, y: number, depth: number, blend = .6, strength = 3, ior = 1.42, width = 2.45) =>
    add([0, 0, depth, width], [x, y, 463.05, 138.915], [463.05, ior, 3.3, .8], [blend, 4, strength, 0]);
  const supportRays = [0, Math.PI / 4, Math.PI / 2].map(angle => [0, .25, .5, 1].map(r => centreSupport(463.05 * r * Math.cos(angle), 463.05 * r * Math.sin(angle), 0)));
  const supportCentreCrossing = [-.001, 0, .001].map(x => centreSupport(x, 0, 0));
  const supportBody = [2.45, 6].map(width => centreSupport(0, 0, 20, .6, 3, 1.42, width));
  const supportOff = [centreSupport(0, 0, 0, 0), centreSupport(0, 0, 0, .6, 0), centreSupport(0, 0, 0, .6, 3, 1)];
  const mixingEndpoints = [0, 1].map(blend => centreSupport(0, 0, 0, blend, 0));
  const mixBrightness = centreSupport(0, 0, 0, .6, 0);

  const regressions = [[0, 0], [0, -400], [-400, -400]].map(([lx, ly]) => {
    const pairs: number[][] = [];
    for (let x = -152; x <= 152; x += 4) for (let y = -19.5; y <= 19.5; y += .5) {
      if (point(x, y)[2] < 0) continue;
      pairs.push([lens(x, y, lx, ly, 23.1525, 0), lens(x, y, lx, ly)]);
    }
    // Include curved ends and sub-DIP shoulders missed by a body-only grid.
    for (const depth of [.1, .35, .75, 1.5, 3, 6]) for (let angle = 0; angle < 360; angle += 5) {
      const c = Math.cos(angle * Math.PI / 180), s = Math.sin(angle * Math.PI / 180);
      const x = Math.sign(c) * 134.5 + (20 - depth) * c, y = (20 - depth) * s;
      pairs.push([lens(x, y, lx, ly, 23.1525, 0), lens(x, y, lx, ly)]);
    }
    return { lightPosition: [lx, ly], pairs };
  });
  // New surface: exercise IOR/TIR, grazing edges and source bounds as well.
  for (const x of [-154.499, -100, 0, 100, 154.499]) for (const y of [0, .001, 19.999]) {
    if (point(x, y)[2] < 0) continue;
    for (const ior of [1, 1.42, 1.65]) lens(x, y, 500, -500, 300, 3, ior);
  }
  const vao = gl.createVertexArray()!; gl.bindVertexArray(vao);
  const input = gl.createBuffer()!, output = gl.createBuffer()!, feedback = gl.createTransformFeedback()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, input); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(cases.flat()), gl.STATIC_DRAW);
  for (const [i, name] of ['a', 'b', 'c', 'd', 'e'].entries()) {
    const location = gl.getAttribLocation(program, name);
    check(location >= 0, `Missing input ${name}`); gl.enableVertexAttribArray(location); gl.vertexAttribPointer(location, 4, gl.FLOAT, false, 80, i * 16);
  }
  gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, feedback);
  gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, output); gl.bufferData(gl.TRANSFORM_FEEDBACK_BUFFER, cases.length * 16, gl.STREAM_READ);
  gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, output);
  gl.useProgram(program); gl.enable(gl.RASTERIZER_DISCARD); gl.beginTransformFeedback(gl.POINTS);
  gl.drawArrays(gl.POINTS, 0, cases.length); gl.endTransformFeedback(); gl.disable(gl.RASTERIZER_DISCARD);
  // Only synthetic optical scalars from a vertex buffer; never texture pixels,
  // never a desktop frame. No readPixels/canvas export/screenshot exists here.
  const values = new Float32Array(cases.length * 4); gl.getBufferSubData(gl.TRANSFORM_FEEDBACK_BUFFER, 0, values);
  check(gl.getError() === gl.NO_ERROR, 'GPU numeric pass failed');
  for (const value of values) check(Number.isFinite(value) && value >= 0, 'Non-finite or negative optical output');
  const value = (i: number) => values[i * 4];
  const falloffValues = falloff.map(value);
  check(falloffValues[0] > falloffValues[1] && falloffValues[1] > falloffValues[2], 'Facing highlight does not attenuate with distance');
  const widths = profiles.map(ids => { const peak = Math.max(...ids.map(value)); return ids.filter(i => value(i) >= peak * .5).length; });
  check(widths[1] > widths[0], 'Larger emitter does not widen reflection footprint');
  check(Math.max(...centre.map(value)) - Math.min(...centre.map(value)) < .0001, 'Discontinuity across source projection');
  check(Math.abs(value(symmetry[0]) - value(symmetry[1])) < .00001, 'Coordinate mirror symmetry broken');
  check(value(noInterface) === 0, 'IOR 1 must not reflect in the direct optical model');
  for (const { id, v } of colors) check(Math.abs(value(id) - v) < .000002, 'SDR transfer changes unlit background');
  const lensValue = (i: number) => value(i) + values[i * 4 + 1];
  check(values[longitudinal[0] * 4 + 2] > .005 && values[longitudinal[2] * 4 + 2] > .005, 'Top is still an extruded cylinder');
  check(values[longitudinal[1] * 4 + 2] < .00001, 'Longitudinal apex has incorrect tangent');
  for (const id of capShoulders) check(values[id * 4 + 2] > .65, 'Convex shoulder collapsed at capsule end');
  check(Math.max(...planoCentre.map(lensValue)) - Math.min(...planoCentre.map(lensValue)) < .0001, 'Plano model jumps across centre');
  const normalF = ((1.42 - 1) / (1.42 + 1)) ** 2;
  check(value(planeBudget) <= normalF + .00001, 'Front interface exceeds its normal-incidence budget');
  check(values[planeBudget * 4 + 1] <= (1 - normalF) ** 2 * normalF + .00001, 'Back interface misses its two transmission losses');
  check(lensValue(lensNoInterface) === 0, 'Plano IOR 1 must have no interface reflection');
  const planoFalloffValues = planoFalloff.map(lensValue);
  check(planoFalloffValues[0] > planoFalloffValues[1] && planoFalloffValues[1] > planoFalloffValues[2], 'Plano reflection lost distance response');
  const supportValues = supportRays.map(ids => ids.map(value));
  for (const ray of supportValues) for (let i = 1; i < ray.length; i++) check(ray[i] < ray[i - 1], 'Centre rim support dims toward source');
  for (let i = 0; i < 4; i++) check(Math.abs(supportValues[0][i] - supportValues[1][i]) < .00001 && Math.abs(supportValues[1][i] - supportValues[2][i]) < .00001, 'Centre support depends on axis orientation');
  check(Math.max(...supportCentreCrossing.map(value)) - Math.min(...supportCentreCrossing.map(value)) < .000001, 'Centre support jumps at origin');
  check(supportBody.every(id => value(id) < .0001), 'Centre support coats transparent body');
  check(supportOff.every(id => value(id) === 0), 'Disabled highlight, IOR 1 or zero distance still adds rim light');
  check(Math.abs(values[mixingEndpoints[0] * 4 + 1] - .1) < .000002 && Math.abs(values[mixingEndpoints[1] * 4 + 1] - .8) < .000002, 'Color blending changes endpoints');
  check(values[mixBrightness * 4 + 1] > .1 * .4 + .8 * .6, 'Intermediate color still mixes in gamma space');
  const regressionStats = regressions.map(({ lightPosition, pairs }) => {
    const summarize = (which: number) => {
      const weights = pairs.map(pair => 1 - Math.exp(-3 * (which ? lensValue(pair[1]) : value(pair[0])))).sort((a, b) => a - b);
      return { p95: weights[Math.floor(weights.length * .95)], max: weights[weights.length - 1], mean: weights.reduce((a, b) => a + b, 0) / weights.length, overHalfFraction: weights.filter(x => x > .5).length / weights.length };
    };
    const prior = summarize(0), corrected = summarize(1);
    check(corrected.p95 < .2 && corrected.overHalfFraction === 0, 'Current user settings still wash out the capsule');
    check(corrected.mean < prior.mean, 'Reported over-brightness not reduced');
    return { lightPosition, samples: pairs.length, prior, corrected };
  });
  const result = { renderer, cases: cases.length, actualMaterialPrograms: 'compiled and linked', finite: true, falloffValues, profileHalfMaximumSampleCounts: widths, angularScanStepDegrees: 1, centreValues: centre.map(value), mirrorValues: symmetry.map(value), colorRoundtrip: true, planoRegression: regressionStats, planoFalloffValues, planeBudget: [value(planeBudget), values[planeBudget * 4 + 1]], longitudinalNormalX: longitudinal.map(i => values[i * 4 + 2]), centreSupportRays: supportValues, centreBodySupport: supportBody.map(value), linearMixedColor: values[mixBrightness * 4 + 1], captureUsed: false, backgroundPixelsRead: false, visualAcceptance: 'not evaluated' };
  gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null); gl.deleteTransformFeedback(feedback);
  gl.deleteBuffer(input); gl.deleteBuffer(output); gl.deleteVertexArray(vao); gl.deleteProgram(program);
  gl.getExtension('WEBGL_lose_context')?.loseContext(); return result;
}
Object.assign(window, { opticsCheck: (async () => {
  try { return { ok: true, result: { ...run(), menu: await verifyMenuGPU(), motionDOM: await verifyMotionDOM(), captureLifecycle: await verifyCaptureLifecycle(), displays: await verifyDisplaysGPU(), elevation: await verifyElevationGPU(), adaptiveFrost: await verifyAdaptiveFrostGPU(), readingDOM: await verifyReadingDOM(), adaptiveInk: await verifyAdaptiveInkGPU(), spatialInk: await verifySpatialInkGPU(), foregroundDOM: await verifyForegroundDOM() } }; }
  catch (error) { return { ok: false, error: String(error) }; }
})() });
