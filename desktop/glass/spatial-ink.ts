import { SIZE } from './contract';
import type { MaskSource } from './foreground-mask';

export type SpatialInkReport = { active: boolean; frames: number; maskUploads: number; maskRevision: number; textRuns: number; icons: number; dots: number; outlines: number; fieldSize: number[]; bytesEstimate: number; error: string | null };
const vertex = `#version 300 es
out vec2 uv;void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);uv=p;gl_Position=vec4(p*2.-1.,0,1);}`;
const field = `#version 300 es
precision highp float;in vec2 uv;out vec4 color;
uniform sampler2D background,history;uniform vec2 size;uniform float blend;
uniform vec4 backgroundRegion,fieldRegion;
void main(){float luminance=0.;float weights=0.;
  vec2 coreUV=(uv-fieldRegion.xy)/fieldRegion.zw;
  bool inside=all(greaterThanEqual(coreUV,vec2(0.)))&&all(lessThanEqual(coreUV,vec2(1.)));
  // Smooth the COLOR FIELD, never the mask or the displayed background.
  for(int y=-2;y<=2;y++)for(int x=-2;x<=2;x++){
    vec2 o=vec2(x,y);float w=exp(-dot(o,o)/3.);
    vec2 point=coreUV+o*2.5/size;
    if(inside)point=clamp(point,vec2(.025,.19),vec2(.975,.81));
    vec4 sampleColor=texture(background,backgroundRegion.xy+point*backgroundRegion.zw);
    vec3 rgb=sampleColor.rgb/max(sampleColor.a,.001);
    vec3 linear=mix(rgb/12.92,pow((rgb+.055)/1.055,vec3(2.4)),step(vec3(.04045),rgb));
    luminance+=dot(linear,vec3(.2126,.7152,.0722))*w;weights+=w;
  }
  float lightInk=1.-smoothstep(.15,.25,luminance/weights);
  color=vec4(vec3(mix(texture(history,uv).r,lightInk,blend)),1.);
}`;
const compose = `#version 300 es
precision highp float;in vec2 uv;out vec4 color;
uniform sampler2D background,field,mask;uniform vec2 size;
uniform vec4 backgroundRegion,fieldRegion;
uniform vec4 regions[6],transforms[6]; uniform float opacity[6];
void main(){vec2 coreUV=(uv-backgroundRegion.xy)/backgroundRegion.zw;vec2 p=vec2(coreUV.x,1.-coreUV.y)*size;float coverage=0.;
  for(int i=0;i<6;i++){
    vec4 r=regions[i],t=transforms[i];vec2 centre=r.xy+r.zw*.5;
    vec2 q=(p-centre-t.zw)/max(t.xy,vec2(.001))+centre;
    if(all(greaterThanEqual(q,r.xy))&&all(lessThanEqual(q,r.xy+r.zw))) coverage=max(coverage,texture(mask,q/size).a*opacity[i]);
  }
  vec4 b=texture(background,uv);
  vec3 ink=mix(vec3(21.,32.,47.)/255.,vec3(246.,250.,255.)/255.,texture(field,fieldRegion.xy+coreUV*fieldRegion.zw).r);
  // Premultiplied output; zero mask leaves material pixels unchanged.
  color=vec4(ink*coverage+b.rgb*(1.-coverage),coverage+b.a*(1.-coverage));
}`;

// All desktop-dependent values stay in WebGL textures. Only local glyphs are
// uploaded from Canvas2D. No queries, pixel readback, PNG or second capture.
export class SpatialInk {
  readonly report: SpatialInkReport;
  private programs: WebGLProgram[] = [];
  private textures: WebGLTexture[] = [];
  private targets: WebGLFramebuffer[] = [];
  private vao: WebGLVertexArrayObject;
  private lastTime = 0;
  private current = 0;
  private revision = -1;
  private disposed = false;
  private remaining = 0;
  private fieldWidth = Math.ceil(SIZE.width / 3);
  private fieldHeight = Math.ceil(SIZE.height / 3);
  private backgroundRegion: [number, number, number, number];
  private fieldRegion: [number, number, number, number];
  private paddedWidth: number; private paddedHeight: number;
  private paddedOrigin: [number, number];
  get backgroundAnimating() { return this.report.active && this.remaining > 0; }
  get animating() { return this.report.active && (this.source.animating || this.remaining > 0); }
  constructor(private gl: WebGL2RenderingContext, private width: number, private height: number, private source: MaskSource, private origin: [number, number] = [0, 0], padding = 0, private size: { width: number; height: number } = SIZE, private groupCount = 6) {
    this.fieldWidth = Math.ceil(size.width / 3); this.fieldHeight = Math.ceil(size.height / 3);
    const px = Math.ceil(padding * width / this.size.width), py = Math.ceil(padding * height / this.size.height);
    this.paddedWidth = width + 2 * px; this.paddedHeight = height + 2 * py;
    this.paddedOrigin = [origin[0] - px, origin[1] - py];
    this.backgroundRegion = [px / this.paddedWidth, py / this.paddedHeight, width / this.paddedWidth, height / this.paddedHeight];
    const columns = Math.ceil(padding * this.fieldWidth / this.size.width), rows = Math.ceil(padding * this.fieldHeight / this.size.height);
    const oldWidth = this.fieldWidth, oldHeight = this.fieldHeight;
    this.fieldWidth += columns * 2; this.fieldHeight += rows * 2;
    // Added texels surround the original grid; its sample centres do not move.
    this.fieldRegion = [columns / this.fieldWidth, rows / this.fieldHeight, oldWidth / this.fieldWidth, oldHeight / this.fieldHeight];
    this.report = { active: false, frames: 0, maskUploads: 0, maskRevision: -1, textRuns: 0, icons: 0, dots: 0, outlines: 0, fieldSize: [this.fieldWidth, this.fieldHeight], bytesEstimate: (this.paddedWidth * this.paddedHeight + width * height) * 4 + this.fieldWidth * this.fieldHeight * 8, error: null };
    this.vao = gl.createVertexArray()!;
    for (const fragment of [groupCount === 6 ? field : field.replace('vec2(.025,.19),vec2(.975,.81)', 'vec2(.025),vec2(.975)'), compose.replaceAll('[6]', `[${groupCount}]`).replace('i<6', `i<${groupCount}`)]) {
      const p = gl.createProgram()!; this.programs.push(p);
      for (const [kind, code] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]] as const) {
        const shader = gl.createShader(kind)!; gl.shaderSource(shader, code); gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error('前景颜色场：' + gl.getShaderInfoLog(shader));
        gl.attachShader(p, shader); gl.deleteShader(shader);
      }
      gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('前景颜色场连接失败');
    }
    for (let i = 0; i < 4; i++) {
      const t = gl.createTexture()!; this.textures.push(t); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, i === 0 ? this.paddedWidth : i === 1 ? width : this.fieldWidth, i === 0 ? this.paddedHeight : i === 1 ? height : this.fieldHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      if (i >= 2) {
        const fb = gl.createFramebuffer()!; this.targets.push(fb); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('前景颜色场帧缓冲失败');
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  stop() { this.source.visible(false); this.report.active = false; this.lastTime = 0; this.remaining = 0; }
  draw(enabled: boolean, reduced: boolean, changed: boolean, now = performance.now()) {
    if (this.disposed) return;
    if (!enabled) { this.stop(); return; }
    const m = this.source.frame();
    if (!m.groups.length || m.groups.length > this.groupCount || (this.groupCount === 6 && m.groups.length !== 6)) { this.stop(); return; }
    const groups = Array.from({ length: this.groupCount }, (_, i) => m.groups[i] ?? { x: 0, y: 0, width: 0, height: 0, scaleX: 1, scaleY: 1, dx: 0, dy: 0, opacity: 0 });
    const gl = this.gl;
    if (changed) this.remaining = 180;
    const dt = this.lastTime ? Math.min(100, now - this.lastTime) : 1000;
    const blend = reduced || !this.lastTime ? 1 : 1 - Math.exp(-dt / 45);
    this.remaining = Math.max(0, this.remaining - dt); this.lastTime = now;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.textures[0]); gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, ...this.paddedOrigin, this.paddedWidth, this.paddedHeight);
    if (this.revision !== m.revision) {
      gl.bindTexture(gl.TEXTURE_2D, this.textures[1]);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, m.canvas);
      this.revision = m.revision; this.report.maskUploads++;
    }
    const next = 1 - this.current, p = this.programs[0];
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.targets[next]); gl.viewport(0, 0, this.fieldWidth, this.fieldHeight);
    gl.bindVertexArray(this.vao); gl.useProgram(p); gl.disable(gl.BLEND);
    const bind = (unit: number, texture: WebGLTexture, name: string, program: WebGLProgram) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, texture); gl.uniform1i(gl.getUniformLocation(program, name), unit); };
    bind(0, this.textures[0], 'background', p); bind(1, this.textures[2 + this.current], 'history', p);
    gl.uniform2f(gl.getUniformLocation(p, 'size'), this.size.width, this.size.height); gl.uniform1f(gl.getUniformLocation(p, 'blend'), blend);
    gl.uniform4fv(gl.getUniformLocation(p, 'backgroundRegion'), this.backgroundRegion); gl.uniform4fv(gl.getUniformLocation(p, 'fieldRegion'), this.fieldRegion);
    gl.drawArrays(gl.TRIANGLES, 0, 3); this.current = next;
    const final = this.programs[1]; gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(...this.paddedOrigin, this.paddedWidth, this.paddedHeight); gl.useProgram(final);
    bind(0, this.textures[0], 'background', final); bind(1, this.textures[2 + next], 'field', final); bind(2, this.textures[1], 'mask', final);
    gl.uniform2f(gl.getUniformLocation(final, 'size'), this.size.width, this.size.height);
    gl.uniform4fv(gl.getUniformLocation(final, 'backgroundRegion'), this.backgroundRegion); gl.uniform4fv(gl.getUniformLocation(final, 'fieldRegion'), this.fieldRegion);
    gl.uniform4fv(gl.getUniformLocation(final, 'regions[0]'), groups.flatMap(g => [g.x, g.y, g.width, g.height]));
    gl.uniform4fv(gl.getUniformLocation(final, 'transforms[0]'), groups.flatMap(g => [g.scaleX, g.scaleY, g.dx, g.dy]));
    gl.uniform1fv(gl.getUniformLocation(final, 'opacity[0]'), groups.map(g => g.opacity ?? 1));
    gl.drawArrays(gl.TRIANGLES, 0, 3); gl.activeTexture(gl.TEXTURE0);
    this.report.active = true; this.report.frames++; this.report.maskRevision = m.revision;
    this.report.textRuns = m.textRuns; this.report.icons = m.icons; this.report.dots = m.dots; this.report.outlines = m.outlines;
    this.source.visible(true);
  }
  dispose() {
    if (this.disposed) return; this.stop(); this.disposed = true;
    const gl = this.gl; this.programs.forEach(p => gl.deleteProgram(p)); this.textures.forEach(t => gl.deleteTexture(t)); this.targets.forEach(f => gl.deleteFramebuffer(f)); gl.deleteVertexArray(this.vao);
  }
}
