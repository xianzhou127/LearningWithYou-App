// Candidate 23: content-weighted edge density drives one capsule-wide blur.
// The source is the UNBLURRED local desktop crop, never UI or the previous blur.
// Scores/history stay on the GPU; no queries, image readback or capture stream.
import { SAMPLE_PAD, type Rect } from './contract';
export type FrostWeights = [number, number, number, number];
export const DEFAULT_FROST_WEIGHTS: FrostWeights = [1, .7, .35, .05];
// Same order as readingRects: status, primary content, feedback, more, grip.
const FALLBACK_REGIONS: Rect[] = [
  { x: 30, y: 12, width: 115, height: 27 }, { x: 178, y: 18, width: 44, height: 16 },
  { x: 257.5, y: 18.5, width: 15, height: 15 }, { x: 284.5, y: 18.5, width: 15, height: 15 }, { x: 10.5, y: 18.5, width: 15, height: 15 },
];
export type FrostReport = { active: boolean; samples: number; baseSigma: number; maximumSigma: number; transitionMs: number; bytesEstimate: number; regional: boolean; weights: number[]; regionSource: 'react' | 'fallback' };
export const FROST_DECODE_GLSL = 'float frostAmount(vec4 state){return dot(state.rg,vec2(65280.,255.))/65535.;}';
const vertex = `#version 300 es
out vec2 uv;void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);uv=p;gl_Position=vec4(p*2.-1.,0,1);}`;
const detail = `#version 300 es
precision highp float;in vec2 uv;out vec4 color;
uniform sampler2D source;uniform vec2 roiSize;
float difference(vec3 a,vec3 b){vec3 d=abs(a-b);return max(dot(d,vec3(.2126,.7152,.0722)),max(d.r,max(d.g,d.b))*.35);}
void main(){
  // Central reading area, 285 x 26 DIP, excluding the optical rim.
  vec2 p=(vec2(${SAMPLE_PAD + 18}.,${SAMPLE_PAD + 13}.)+uv*vec2(285.,26.))/roiSize;
  vec3 centre=texture(source,p).rgb;float contrast=0.;
  for(int i=0;i<2;i++){
    vec2 d=vec2(i==0?1.25:2.75)/roiSize;
    contrast=max(contrast,difference(centre,texture(source,p+vec2(d.x,0)).rgb));
    contrast=max(contrast,difference(centre,texture(source,p-vec2(d.x,0)).rgb));
    contrast=max(contrast,difference(centre,texture(source,p+vec2(0,d.y)).rgb));
    contrast=max(contrast,difference(centre,texture(source,p-vec2(0,d.y)).rgb));
  }
  color=vec4(smoothstep(.045,.22,contrast),0,0,1);
}`;
const integrate = `#version 300 es
precision highp float;out vec4 color;
uniform sampler2D details,history;uniform float threshold,dt,transitionMs;uniform bool reset,reduced;
uniform bool regional;uniform vec4 regions[5],importance;
${FROST_DECODE_GLSL}
float weightAt(vec2 p){
  if(!regional)return 1.;float w=importance.w;
  for(int i=0;i<5;i++){
    vec4 r=regions[i];vec2 outside=max(max(r.xy-p,p-r.xy-r.zw),vec2(0));
    float coverage=1.-smoothstep(0.,4.,length(outside));
    float priority=i==0?importance.x:i==1?importance.y:importance.z;
    w=mix(w,priority,coverage);
  }
  return w;
}
void main(){float density=0.,total=0.;
  for(int y=0;y<8;y++)for(int x=0;x<48;x++){
    // Detail texture is bottom-up; React rectangles use top-down local DIP.
    vec2 p=vec2(18.,39.)+(vec2(x,y)+.5)*vec2(285./48.,-26./8.);
    float w=weightAt(p);density+=texelFetch(details,ivec2(x,y),0).r*w;total+=w;
  }
  density/=max(total,.0001);float target=smoothstep(threshold,min(.95,threshold+.22),density);
  float prior=reset?0.:frostAmount(texelFetch(history,ivec2(0),0));
  // One symmetric response. The UI duration means time to 90% of a step change.
  float blend=(reduced||transitionMs<1.)?1.:1.-exp(-dt*2.302585093/transitionMs);
  float next=mix(prior,target,blend);
  // Pack history into 16 UNORM bits; single-channel RGBA8 stalls on slow release.
  if(abs(next-target)<.0004)next=target;
  float bits=floor(clamp(next,0.,1.)*65535.+.5);
  color=vec4(vec2(floor(bits/256.),mod(bits,256.))/255.,density,target);
}`;

export class AdaptiveFrost {
  readonly report: FrostReport = { active: false, samples: 0, baseSigma: 0, maximumSigma: 0, transitionMs: 400, bytesEstimate: (48 * 8 + 2) * 4, regional: true, weights: [...DEFAULT_FROST_WEIGHTS], regionSource: 'fallback' };
  private programs: WebGLProgram[] = [];
  private textures: WebGLTexture[] = [];
  private targets: WebGLFramebuffer[] = [];
  private vao: WebGLVertexArrayObject;
  private current = 0;
  private lastTime = 0;
  private disposed = false;
  private regions = FALLBACK_REGIONS.flatMap(r => [r.x, r.y, r.width, r.height]);
  get texture() { return this.textures[1 + this.current]; }
  layoutChanged(rects: readonly Rect[]) {
    const valid = rects.length === 5 && rects.every(r => [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0);
    this.regions = (valid ? rects : FALLBACK_REGIONS).flatMap(r => [r.x, r.y, r.width, r.height]);
    this.report.regionSource = valid ? 'react' : 'fallback';
  }
  private rows = 8;
  constructor(private gl: WebGL2RenderingContext, panel?: { width: number; height: number }) {
    let detailShader = detail, integrateShader = integrate;
    if (panel) {
      const w = panel.width - 32, h = panel.height - 32;
      this.rows = Math.min(64, Math.max(8, Math.ceil(h / 3.25)));
      detailShader = detail.replace('vec2(82.,77.)+uv*vec2(285.,26.)', 'vec2(80.,80.)+uv*vec2(' + w.toFixed(3) + ',' + h.toFixed(3) + ')');
      integrateShader = integrate.replace('y<8', 'y<' + this.rows).replace('vec2(18.,39.)+(vec2(x,y)+.5)*vec2(285./48.,-26./8.)', 'vec2(16.,' + (panel.height - 16).toFixed(3) + ')+(vec2(x,y)+.5)*vec2(' + w.toFixed(3) + '/48.,-' + h.toFixed(3) + '/' + this.rows.toFixed(1) + ')');
      this.report.bytesEstimate = (48 * this.rows + 2) * 4;
    }
    this.vao = gl.createVertexArray()!;
    try {
      for (const fragment of [detailShader, integrateShader]) {
        const p = gl.createProgram()!; this.programs.push(p);
        for (const [kind, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]] as const) {
          const shader = gl.createShader(kind)!; gl.shaderSource(shader, source); gl.compileShader(shader);
          if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) { const log = gl.getShaderInfoLog(shader); gl.deleteShader(shader); throw new Error('自适应毛玻璃：' + log); }
          gl.attachShader(p, shader); gl.deleteShader(shader);
        }
        gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('毛玻璃程序连接失败');
      }
      for (let i = 0; i < 3; i++) {
        const texture = gl.createTexture()!; this.textures.push(texture); gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, i === 0 ? 48 : 1, i === 0 ? this.rows : 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        const fb = gl.createFramebuffer()!; this.targets.push(fb); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('毛玻璃帧缓冲失败');
      }
    } catch (error) { this.dispose(); throw error; }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  stop() { this.report.active = false; this.lastTime = 0; }
  draw(source: WebGLTexture, roiSize: [number, number], base: number, maximum: number, threshold: number, reduced: boolean, changed: boolean, now = performance.now(), transitionMs = 400, regional = true, weights: FrostWeights = DEFAULT_FROST_WEIGHTS) {
    if (this.disposed) throw new Error('毛玻璃资源已释放');
    const gl = this.gl, reset = !this.report.active;
    gl.bindVertexArray(this.vao); gl.disable(gl.BLEND);
    if (changed || reset) {
      const p = this.programs[0]; gl.useProgram(p); gl.bindFramebuffer(gl.FRAMEBUFFER, this.targets[0]); gl.viewport(0, 0, 48, this.rows);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, source); gl.uniform1i(gl.getUniformLocation(p, 'source'), 0);
      gl.uniform2fv(gl.getUniformLocation(p, 'roiSize'), roiSize); gl.drawArrays(gl.TRIANGLES, 0, 3); this.report.samples++;
    }
    const next = 1 - this.current, p = this.programs[1]; gl.useProgram(p); gl.bindFramebuffer(gl.FRAMEBUFFER, this.targets[1 + next]); gl.viewport(0, 0, 1, 1);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.textures[0]); gl.uniform1i(gl.getUniformLocation(p, 'details'), 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.texture); gl.uniform1i(gl.getUniformLocation(p, 'history'), 1);
    gl.uniform1f(gl.getUniformLocation(p, 'threshold'), threshold); gl.uniform1f(gl.getUniformLocation(p, 'dt'), reset ? 16 : Math.max(0, Math.min(100, now - this.lastTime)));
    gl.uniform1f(gl.getUniformLocation(p, 'transitionMs'), transitionMs);
    gl.uniform1i(gl.getUniformLocation(p, 'regional'), regional ? 1 : 0);
    gl.uniform4fv(gl.getUniformLocation(p, 'regions[0]'), this.regions); gl.uniform4fv(gl.getUniformLocation(p, 'importance'), weights);
    gl.uniform1i(gl.getUniformLocation(p, 'reset'), reset ? 1 : 0); gl.uniform1i(gl.getUniformLocation(p, 'reduced'), reduced ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3); this.current = next; this.lastTime = now;
    this.report.active = true; this.report.baseSigma = base; this.report.maximumSigma = Math.max(base, maximum); this.report.transitionMs = transitionMs;
    this.report.regional = regional; this.report.weights = [...weights];
    gl.activeTexture(gl.TEXTURE0); gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  dispose() {
    if (this.disposed) return; this.stop(); this.disposed = true;
    const gl = this.gl; this.programs.forEach(p => gl.deleteProgram(p)); this.textures.forEach(t => gl.deleteTexture(t)); this.targets.forEach(f => gl.deleteFramebuffer(f)); gl.deleteVertexArray(this.vao);
  }
}
