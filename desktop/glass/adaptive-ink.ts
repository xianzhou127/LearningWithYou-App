import type { Rect } from './contract';

export type InkTone = 'dark' | 'light';
export type InkReport = { tones: InkTone[]; completed: number; switches: number; queryAgeMs: number; pending: boolean; error: string | null };
// Linear-light luminance hysteresis, centred near equal contrast for our two inks.
// State is presentation only; it never drives a learning session.
export const inkThreshold = (tone?: InkTone) => tone === 'dark' ? .17 : tone === 'light' ? .23 : .20;
export const INK_INTERVAL_MS = 100;
export class InkStability {
  tones: InkTone[] = [];
  private votes: number[] = [];
  switches = 0;
  accept(dark: boolean[]) {
    dark.forEach((value, i) => {
      const next: InkTone = value ? 'dark' : 'light';
      if (!this.tones[i]) { this.tones[i] = next; this.votes[i] = 0; }
      else if (this.tones[i] === next) this.votes[i] = 0;
      else if ((this.votes[i] = (this.votes[i] || 0) + 1) >= 2) { this.tones[i] = next; this.votes[i] = 0; this.switches++; }
    });
    return [...this.tones];
  }
}

const vertex = `#version 300 es
void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.-1.,0,1);}`;
const fragment = `#version 300 es
precision highp float;
uniform sampler2D background; uniform vec4 region; uniform vec2 size; uniform float threshold;
out vec4 color;
void main(){
  float luminance=0.;
  // Forty samples per group, in the final shaded glass texture. No glyphs are
  // captured, so changing the foreground cannot feed back into classification.
  for(int y=0;y<4;y++) for(int x=0;x<10;x++){
    vec2 p=region.xy+region.zw*(vec2(float(x)+.5,float(y)+.5)/vec2(10.,4.));
    vec3 rgb=texture(background,vec2(p.x/size.x,1.-p.y/size.y)).rgb;
    vec3 linear=mix(rgb/12.92,pow((rgb+.055)/1.055,vec3(2.4)),step(vec3(.04045),rgb));
    luminance+=dot(linear,vec3(.2126,.7152,.0722));
  }
  if(luminance/40. < threshold) discard;
  color=vec4(0.);
}`;

// GPU -> CPU output is ONLY one occlusion-query boolean per group, never RGB,
// luminance, pixels, images or a transferable desktop texture. No readPixels,
// getBufferSubData, gl.finish, synchronous waiting or second capture stream.
export class AdaptiveInk {
  private program: WebGLProgram;
  private texture: WebGLTexture;
  private target: WebGLFramebuffer;
  private storage: WebGLRenderbuffer;
  private vao: WebGLVertexArrayObject;
  private uniforms: Record<'background' | 'region' | 'size' | 'threshold', WebGLUniformLocation>;
  private pending: WebGLQuery[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private layout: Rect[] = [];
  private stable = new InkStability();
  private lastSubmit = -Infinity;
  private submittedAt = 0;
  private enabled = false;
  private disposed = false;
  readonly report: InkReport = { tones: [], completed: 0, switches: 0, queryAgeMs: 0, pending: false, error: null };
  constructor(private gl: WebGL2RenderingContext, private width: number, private height: number, private size: { width: number; height: number }, private onTones: (tones: InkTone[] | null) => void, private origin: [number, number] = [0, 0]) {
    this.program = gl.createProgram()!;
    for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]] as const) {
      const shader = gl.createShader(type)!; gl.shaderSource(shader, source); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error('文字明暗着色器：' + gl.getShaderInfoLog(shader));
      gl.attachShader(this.program, shader); gl.deleteShader(shader);
    }
    gl.linkProgram(this.program);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) throw new Error('文字明暗着色器连接失败');
    this.uniforms = Object.fromEntries(['background', 'region', 'size', 'threshold'].map(name => [name, gl.getUniformLocation(this.program, name)!])) as typeof this.uniforms;
    this.vao = gl.createVertexArray()!;
    this.texture = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    this.target = gl.createFramebuffer()!; gl.bindFramebuffer(gl.FRAMEBUFFER, this.target);
    this.storage = gl.createRenderbuffer()!; gl.bindRenderbuffer(gl.RENDERBUFFER, this.storage);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, 1, 1);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, this.storage);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('文字明暗帧缓冲不可用');
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  layoutChanged(rects: Rect[]) {
    this.cancelPending(); this.layout = rects; this.lastSubmit = -Infinity;
  }
  // Called after the normal material draw; copy is GPU-local and at most 10 Hz.
  sample(enabled: boolean, now = performance.now()) {
    if (this.disposed) return;
    if (!enabled) { if (this.enabled) this.reset(); return; }
    this.enabled = true;
    if (this.report.error || !this.layout.length || this.pending.length || now - this.lastSubmit < INK_INTERVAL_MS) return;
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, ...this.origin, this.width, this.height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.target); gl.viewport(0, 0, 1, 1);
    gl.useProgram(this.program); gl.bindVertexArray(this.vao);
    gl.uniform1i(this.uniforms.background, 0); gl.uniform2f(this.uniforms.size, this.size.width, this.size.height);
    gl.colorMask(false, false, false, false);
    for (const [i, r] of this.layout.entries()) {
      const q = gl.createQuery()!;
      gl.uniform4f(this.uniforms.region, r.x, r.y, r.width, r.height);
      gl.uniform1f(this.uniforms.threshold, inkThreshold(this.stable.tones[i]));
      gl.beginQuery(gl.ANY_SAMPLES_PASSED, q); gl.drawArrays(gl.TRIANGLES, 0, 3); gl.endQuery(gl.ANY_SAMPLES_PASSED);
      this.pending.push(q);
    }
    gl.colorMask(true, true, true, true); gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(...this.origin, this.width, this.height);
    this.lastSubmit = now; this.submittedAt = performance.now(); this.report.pending = true;
    this.timer = setTimeout(() => this.poll(), 16);
  }
  private poll() {
    this.timer = undefined;
    const gl = this.gl;
    if (this.disposed || !this.pending.length) return;
    const age = performance.now() - this.submittedAt;
    if (gl.isContextLost() || age > 1000) {
      this.cancelPending(); this.report.error = '文字明暗查询失效，请重开采集'; this.onTones(null); return;
    }
    if (!this.pending.every(q => gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE))) { this.timer = setTimeout(() => this.poll(), 16); return; }
    const dark = this.pending.map(q => Boolean(gl.getQueryParameter(q, gl.QUERY_RESULT)));
    this.cancelPending(); this.report.tones = this.stable.accept(dark); this.report.completed++;
    this.report.switches = this.stable.switches; this.report.queryAgeMs = age;
    this.onTones([...this.report.tones]);
  }
  private cancelPending() {
    if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    this.pending.forEach(q => this.gl.deleteQuery(q)); this.pending = []; this.report.pending = false;
  }
  private reset() { this.cancelPending(); this.enabled = false; this.stable = new InkStability(); this.report.tones = []; this.lastSubmit = -Infinity; this.onTones(null); }
  dispose() {
    if (this.disposed) return;
    this.reset(); this.disposed = true;
    const gl = this.gl; gl.deleteTexture(this.texture); gl.deleteFramebuffer(this.target); gl.deleteRenderbuffer(this.storage); gl.deleteProgram(this.program); gl.deleteVertexArray(this.vao);
  }
}
