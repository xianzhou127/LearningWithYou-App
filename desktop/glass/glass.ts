import { SIZE, SAMPLE_PAD, type Geometry, type Mode } from './contract';
import { regionUV, screenLightPosition } from './geometry';
import type { MaterialSettings } from './material-settings';
import { distanceLight, DISTANCE_LIGHT_GLSL } from './distance-light';
import { AdaptiveInk, type InkTone } from './adaptive-ink';
import type { Rect } from './contract';
import { SpatialInk } from './spatial-ink';
import type { MaskSource } from './foreground-mask';
import { AdaptiveFrost, FROST_DECODE_GLSL } from './adaptive-frost';
import { REST_POSE, type MotionPose } from './motion';
import { ELEVATION_PAD, ELEVATION_GLSL } from './elevation';
import { PULL_GLSL } from './deformation';
import { panelMaterial } from './panel-shaders';
import { intersection } from './desktop-layout';
import type { DisplayAdaptation } from './display-adaptation';
export type GlassSource = { video: HTMLVideoElement; display: Rect; frame: number };
// Gaussian pass derived from liquid-glass-studio, MIT, Charles Yin (2024).
// See upstream/LICENSE.txt and UPSTREAM.md. No demo background is drawn outside SDF.
const vertex = `#version 300 es
out vec2 uv;
void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);uv=p;gl_Position=vec4(p*2.-1.,0,1);}`;
const header = `#version 300 es
precision highp float;
in vec2 uv; out vec4 color; uniform sampler2D source;`;
const crop = header + `uniform vec4 region;
void main(){vec2 top=vec2(uv.x,1.-uv.y);color=texture(source,region.xy+top*region.zw);}`;
export const BLUR_FRAGMENT = header + `uniform vec2 stepSize; uniform float sigma;
uniform sampler2D frost; uniform bool adaptiveFrost; uniform float maximumSigma;
${FROST_DECODE_GLSL}
void main(){vec4 sum=vec4(0);float weights=0.;
float s=adaptiveFrost?mix(sigma,max(sigma,maximumSigma),frostAmount(texelFetch(frost,ivec2(0),0))):sigma;
// Preserve <=3 exactly. Add outer taps continuously up to 12 DIP, retaining
// 1 DIP spacing so high sigma cannot alias dense stripes as a sparse kernel can.
for(int i=-12;i<=12;i++){float offset=float(i);float w=exp(-offset*offset/(2.*s*s));
if(abs(offset)>6.)w*=clamp(2.*s+1.-abs(offset),0.,1.);
if(w>0.){sum+=texture(source,uv+offset*stepSize)*w;weights+=w;}}
color=sum/weights;}`;
const material = header + `uniform vec2 size; uniform float dpr; uniform vec2 roiSize;
uniform vec2 outputOffset; // physical pixels; foreground retains original bounds
uniform bool elevation; uniform vec3 elevationProfile; // range, hardness, spread
uniform sampler2D sharp; uniform bool fullMaterial;
uniform vec4 surface; // strength, width, Fresnel, lower shade
uniform vec4 optics; // edge width, IOR, displacement limit, tint
uniform vec2 lightDirection; uniform vec2 finish; // contour, shadow
uniform vec3 lightPosition; uniform bool screenLight;
uniform vec4 glareProfile; // opposite strength, convergence, spectral spread DIP, preserved chroma
uniform bool dualLight;
uniform float lightBalance;
uniform vec3 distanceProfile; // height DIP, radius DIP, blend with candidate 13
uniform bool planoLens;
uniform bool centerBalance;
uniform int debugView;
uniform vec4 motionShape; uniform float motionGain; uniform vec2 motionLocal; uniform float motionElevation;
uniform vec3 motionContact; uniform vec2 motionRipple,motionTug,motionFeedback;
uniform float motionEnergy, motionInflation; uniform vec2 motionLightField;
${DISTANCE_LIGHT_GLSL}
${ELEVATION_GLSL}
${PULL_GLSL}
vec2 gripPoint(){return (vec2(motionContact.x,size.y-motionContact.y)-size*.5-motionShape.zw-vec2(0.,motionElevation*.8))/motionShape.xy;}
vec2 flexPoint(vec2 q){
  if(dot(motionTug,motionTug)==0.)return q;
  // Forward displacement is +tug * weight. Invert that map rather than
  // offsetting the remote half in the opposite direction (candidate7).
  vec2 origin=size*.5+motionShape.zw+vec2(0.,motionElevation*.8);
  return (unpull(q*motionShape.xy+origin,motionTug,motionContact.x,origin.y)-origin)/motionShape.xy;
}
float flexDistance(vec2 q){
  vec2 undeformed=flexPoint(q);
  vec2 fromContact=undeformed-gripPoint();
  float bulge=motionContact.z*exp(-dot(fromContact,fromContact)/(80.*80.));
  return capsuleSdf(undeformed)-motionElevation*.6-motionInflation-bulge;
}
void main(){vec2 local=(gl_FragCoord.xy-outputOffset)/dpr;vec2 p=(local-size*.5-motionShape.zw-vec2(0.,motionElevation*.8))/motionShape.xy;float dist=flexDistance(p);float aa=max(fwidth(dist),.5/dpr);float a=1.-smoothstep(-aa*.5,aa*.5,dist);
// Legacy B / comparison keeps the 3 DIP shadow. C adds a bounded soft shadow
// away from the existing light; only alpha is emitted outside the glass.
float shadow=(fullMaterial?finish.y:.12)*exp(-max(dist,0.)*max(dist,0.)/2.)*(1.-smoothstep(2.,3.,dist));
if(fullMaterial && elevation){
  vec2 away=screenLight ? -lightPosition.xy/max(length(vec3(lightPosition.xy,distanceProfile.x)),.001) : -lightDirection;
  // A visible elevation cue needs separation/spread, not just +.016 alpha.
  // Keep the candidate24 spread ceiling; output padding covers strength 5.
  float spread=min(10.,elevationProfile.z*(1.+.12*motionElevation));
  vec2 offset=away*2.5+vec2(0.,-1.8*motionElevation);
  float shadowDistance=max(flexDistance(p-offset),0.);
  shadow=finish.y*exp(-.5*shadowDistance*shadowDistance/(spread*spread))*(1.-smoothstep(2.5*spread,3.*spread,shadowDistance));
}
float contour=fullMaterial ? finish.x*(1.-smoothstep(0.,.9,max(dist,0.))) : 0.;
float outsideAlpha=min(.95,max(shadow,contour)*(1.+motionGain));
if(a<=0.){color=vec4(0.,0.,0.,outsideAlpha);return;}
vec2 tuv=(local+vec2(${SAMPLE_PAD}.))/roiSize;
vec3 rgb=mix(texture(source,tuv).rgb,vec3(.94,.965,1.),.12);
if(fullMaterial){
  // Adapted from upstream STEP 9: SDF depth -> incidence/refraction angles,
  // normal-directed displacement, edge clarity, Fresnel and directional glare.
  // Bounded toolbar parameters; no global zoom or outside background.
  float depth=max(-dist,0.);
  float edge=clamp(1.-depth/optics.x,0.,1.);
  vec2 radial=p-vec2(clamp(p.x,-134.5,134.5),0.);
  vec2 normal=radial/max(length(radial),.0001);
  if(motionContact.z!=0. || dot(motionTug,motionTug)>0.){
    // Differentiate the actual flexed surface; desktop UV and foreground stay
    // in the unwarped shell coordinates. Neutral pose uses the original normal.
    vec2 gradient=vec2(flexDistance(p+vec2(.15,0.))-flexDistance(p-vec2(.15,0.)),
                       flexDistance(p+vec2(0.,.15))-flexDistance(p-vec2(0.,.15)));
    normal=gradient/max(length(gradient),.0001);
  }
  float thetaI=asin(min(edge,.97));
  float thetaT=asin(sin(thetaI)/optics.y);
  float displacement=min(optics.z,1.5*optics.z*tan(thetaI-thetaT));
  vec2 sampleUV=tuv-normal*displacement/roiSize;
  float blurMix=.1+.9*smoothstep(0.,optics.x*.9,depth);
  float spread=glareProfile.z*clamp(displacement/max(optics.z,.0001),0.,1.);
  if(spread>.0001){
    // Upstream getTextureDispersion: red samples farther along refraction,
    // blue nearer. Split only the captured texture, never React text/icons.
    vec2 spectral=normal*spread/roiSize;
    vec3 clearPixel=vec3(texture(sharp,sampleUV-spectral).r,texture(sharp,sampleUV).g,texture(sharp,sampleUV+spectral).b);
    vec3 blurredPixel=vec3(texture(source,sampleUV-spectral).r,texture(source,sampleUV).g,texture(source,sampleUV+spectral).b);
    rgb=mix(clearPixel,blurredPixel,blurMix);
  }else rgb=mix(texture(sharp,sampleUV).rgb,texture(source,sampleUV).rgb,blurMix);
  vec3 refracted=rgb;
  // Local luminance in the shader keeps dark-document text readable. Pixels
  // never leave the GPU; React labels are never sampled or distorted.
  float luminance=dot(rgb,vec3(.2126,.7152,.0722));
  float coat=clamp(clamp((.75-luminance)*.90,.10,.60)*mix(.4,1.,smoothstep(0.,optics.x*.9,depth))*optics.w,0.,1.);
  rgb=mix(rgb,vec3(.95,.973,1.),coat);
  vec3 baseRgb=rgb;
  vec2 light=lightDirection;
  float directional=1.;
  if(screenLight){
    vec2 toLight=lightPosition.xy-p;
    float distance2=dot(toLight,toLight);
    light=toLight/max(sqrt(distance2),.0001);
    // The source sits above the screen plane. Fade angular contrast smoothly
    // near its projection so crossing the centre never normalizes zero or snaps.
    directional=distance2/(distance2+lightPosition.z*lightPosition.z);
  }
  float fresnel=elevation ? rimReflection(depth,elevationProfile.x,elevationProfile.y) : pow(edge,5.);
  float alignment=clamp(dot(normal,light),-1.,1.);
  // dot(n,l)^2 = (1 + cos(2*(normalAngle-lightAngle)))/2:
  // the upstream double-angle glare distribution, with an explicit opposite lobe.
  float axis=alignment*alignment;
  // Retain the signed normal: squaring alone makes opposite lobes identical.
  // Smoothly favor the source-facing rim in both intensity and radial/angular
  // width; fade the asymmetry with source elevation near the screen centre.
  float bias=dualLight ? lightBalance*directional*alignment : 0.;
  float widthScale=1.+.6*bias;
  float gain=1.+.75*bias;
  float glare=dualLight
    ? pow(axis,glareProfile.y/widthScale)*(alignment<0.?glareProfile.x:1.)*gain
    : pow(max(alignment,0.),2.)+.22*pow(max(-alignment,0.),3.);
  glare*=directional;
  float rim=exp(-depth/surface.y);
  float glareRim=exp(-depth/(surface.y*widthScale));
  // The dark pair is perpendicular to the bright pair, not opposite it.
  // At 135 degrees: NW/SE reflect, NE/SW attenuate. No inset ring-shaped groove.
  float shade=dualLight ? pow(max(0.,1.-axis),glareProfile.y) : .277+pow(max(-alignment,0.),1.5);
  rgb*=1.-surface.w*shade*rim*directional;
  // Smooth energy compression preserves near/far differences even when the
  // operator raises strength above 1. A hard clamp made both lobes equally white.
  float glareReflection=1.-exp(-surface.x*glare*glareRim);
  float reflection=dualLight
    ? 1.-(1.-min(surface.z*fresnel,.98))*(1.-glareReflection)
    : clamp(surface.z*fresnel+surface.x*glare*rim,0.,.98);
  // Bounded hue-preserving reflection approximates upstream's LCH lightness /
  // chroma boost without importing its full color pipeline or an HDR bloom pass.
  float peak=max(max(refracted.r,refracted.g),refracted.b);
  vec3 hue=peak>.0001 ? refracted/peak : vec3(1.);
  vec3 reflectionColor=mix(vec3(1.),hue,glareProfile.w*smoothstep(0.,.15,peak));
  rgb=mix(rgb,reflectionColor,reflection);
  if(screenLight && distanceProfile.z>0.){
    vec3 toCentre=vec3(lightPosition.xy-p,distanceProfile.x);
    float energy;
    if(planoLens){
      vec2 interfaces=planoReflection(p,normal,depth,surface.y,toCentre,
        distanceProfile.y,distanceProfile.x,optics.y,glareProfile.y,
        dualLight?glareProfile.x:0.,lightBalance);
      energy=interfaces.x+interfaces.y;
    }else energy=distanceReflection(normal,depth,surface.y,toCentre,
      distanceProfile.y,distanceProfile.x,optics.y,glareProfile.y,
      dualLight?glareProfile.x:0.,lightBalance);
    float direct=1.-exp(-surface.x*energy);
    float areaReflection=1.-(1.-min(surface.z*fresnel,.98))*(1.-direct);
    // Keep the user-controlled ambient contour/shade, without multiplying the
    // transmitted desktop by the light's inverse-square attenuation.
    float planar=dot(toCentre.xy,toCentre.xy)/dot(toCentre,toCentre);
    vec3 shaded=baseRgb*(1.-surface.w*shade*rim*planar);
    vec3 linearResult=mix(srgbToLinear(shaded),srgbToLinear(reflectionColor),areaReflection);
    if(planoLens && centerBalance){
      // Blend rendered colors in linear light, preserving both old endpoints.
      // Mixing sRGB outputs darkened intermediate legacy/plano settings.
      float combined=mix(reflection,areaReflection,distanceProfile.z);
      float support=centreRimSupport(lightPosition.xy,distanceProfile.x,depth,
        surface.y,surface.x,distanceProfile.z,optics.y);
      reflection=1.-(1.-combined)*(1.-support);
      rgb=balanceReflectedColor(rgb,linearResult,reflectionColor,distanceProfile.z,support);
    }else{
      rgb=mix(rgb,linearToSrgb(linearResult),distanceProfile.z);
      reflection=mix(reflection,areaReflection,distanceProfile.z);
    }
  }
  // Bounded temporary rim light. Sampling still uses untransformed local position.
  // No centre scrim, no change to user settings or adaptive blur.
  float localGain=motionLocal.x*exp(-pow((local.x-215.)/40.,2.))+motionLocal.y*exp(-pow((local.x-269.)/22.,2.));
  float motionShoulder=rimReflection(depth,elevationProfile.x*(1.+.12*motionElevation),elevationProfile.y);
  float motionBudget=1.-exp(-(surface.x+surface.z));
  // Do not attenuate a 10% interaction by the user's .15 Fresnel a second time.
  float motionRim=min(.3,(motionGain*.8+motionElevation*.12+localGain*1.4)*motionBudget)*motionShoulder;
  vec2 contactRay=local-(vec2(motionContact.x,size.y-motionContact.y)+motionTug);
  float touchDistance=length(contactRay);
  float waveWidth=max(1.,motionLightField.x);
  float front=exp(-pow((touchDistance-motionRipple.x)/waveWidth,2.));
  float wake=(1.-smoothstep(motionRipple.x,motionRipple.x+waveWidth,touchDistance))*exp(-touchDistance/max(waveWidth,motionRipple.x));
  float outgoing=motionRipple.y*(front+.28*wake);
  float feedbackDistance=length(local-vec2(265.,26.));
  float incoming=motionFeedback.y*exp(-pow((feedbackDistance-motionFeedback.x)/13.,2.));
  // Feedback retains its short rim arc. Contact light fills the actual glass
  // interior radially: neither the rim shoulder nor a normal-facing mask may
  // suppress it between the upper and lower borders.
  motionRim=min(.65,motionRim+incoming*motionBudget*motionShoulder);
  // Virtual light beneath the contact follows the same strain and stored /
  // kinetic energy as the surface. The normal comes from the deformed SDF.
  // Its lobe bends with the pull; no rectangular fill or static material edit.
  vec2 lightRay=contactRay+motionTug*2.;
  float underLight=exp(-dot(lightRay,lightRay)/(72.*72.));
  float internalLight=clamp((underLight*.12*motionEnergy+outgoing*.62)*motionBudget*motionLightField.y,0.,.72);
  motionRim=clamp(motionRim,0.,.65);
  // White paper has no headroom for another white reflection. Use the local
  // transmitted background BEFORE static reflections or motion to smoothly
  // reverse only the transient light. Reuse GPU luminance: no extra sampling,
  // history, readback, or persistent dark patch when the interaction settles.
  float darkResponse=smoothstep(.55,.85,luminance);
  vec3 motionColor=mix(reflectionColor,vec3(0.),darkResponse);
  rgb=mix(rgb,motionColor,internalLight);
  rgb=mix(rgb,motionColor,motionRim);
  // Explicit diagnostic views, never used for real-desktop acceptance.
  if(debugView==1) rgb=vec3(.06+.94*reflection);
  if(debugView==2) rgb=vec3(displacement/8.,.1,.1);
}
// A sub-DIP contact contour outside the glass gives white SDR paper a visible
// silhouette without restoring the concave-looking inner groove.
float alpha=a+outsideAlpha*(1.-a);color=vec4(rgb*a,alpha);}`;
type TimerExtension = { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number };
export class Glass {
  private get size() { return this.panel ?? SIZE; }
  private gl: WebGL2RenderingContext;
  private programs: WebGLProgram[] = [];
  private textures: WebGLTexture[] = [];
  private targets: WebGLFramebuffer[] = [];
  private vao: WebGLVertexArrayObject;
  private queries: WebGLQuery[] = [];
  private displayTextures = new Map<HTMLVideoElement, { texture: WebGLTexture; frame: number }>();
  private ext: TimerExtension | null;
  readonly gpuTimes: number[] = [];
  readonly uploadTimes: number[] = [];
  materialBranch: number | null = null;
  appliedMaterialRevision: number | null = null;
  lighting: { screenCenter: boolean; localPoint: number[]; distanceModel: ReturnType<typeof distanceLight> } | null = null;
  uniformReadback: { surface: number[]; optics: number[]; finish: number[]; light: number[]; glare: number[]; dualLight: number; lightBalance: number; distance: number[]; planoLens: number; centerBalance: number; debugView: number; elevation?: number; elevationProfile?: number[]; contentPixels?: number[] } | null = null;
  motionApplied: Pick<MotionPose, 'elevation' | 'gain' | 'shape' | 'localLight' | 'contact' | 'ripple' | 'tug' | 'feedbackRing' | 'energy' | 'inflation' | 'lightField'> | null = null;
  private lastMode: Mode | null = null;
  private ink: AdaptiveInk;
  private spatial: SpatialInk | null = null;
  private frost: AdaptiveFrost | null = null;
  private readingRects: Rect[] = [];
  get frostSupport() { return this.frost?.report ?? null; }
  get spatialSupport() { return this.spatial?.report ?? null; }
  get backgroundAnimating() { return this.spatial?.backgroundAnimating ?? false; }
  get foregroundAnimating() { return this.spatial?.animating ?? false; }
  get readingSupport() { return this.ink.report; }
  setReadingRects(rects: Rect[]) { this.readingRects = rects; this.ink.layoutChanged(rects); this.frost?.layoutChanged(rects); }
  readonly renderer: string;
  readonly roi: { width: number; height: number };
  readonly contentPixels: { x: number; y: number; width: number; height: number };
  constructor(private canvas: HTMLCanvasElement, readonly dpr: number, onTones: (tones: InkTone[] | null) => void = () => {}, private maskSource?: MaskSource, prepared?: DisplayAdaptation, private panel?: { width: number; height: number; radius: number }) {
    const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: 'low-power' });
    if (!gl) throw new Error('WebGL2 不可用'); this.gl = gl;
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    this.renderer = String(gl.getParameter(debug?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER));
    const pad = Math.ceil(ELEVATION_PAD * dpr);
    this.contentPixels = prepared?.contentPixels ?? { x: pad, y: pad, width: Math.round(this.size.width * dpr), height: Math.round(this.size.height * dpr) };
    canvas.width = prepared?.outputPixels.width ?? this.contentPixels.width + pad * 2; canvas.height = prepared?.outputPixels.height ?? this.contentPixels.height + pad * 2;
    Object.assign(canvas.style, { position: 'absolute', left: `${-pad / dpr}px`, top: `${-pad / dpr}px`, width: `${canvas.width / dpr}px`, height: `${canvas.height / dpr}px` });
    this.roi = prepared?.roiPixels ?? { width: Math.round((this.size.width + SAMPLE_PAD * 2) * dpr), height: Math.round((this.size.height + SAMPLE_PAD * 2) * dpr) };
    for (const frag of [crop, BLUR_FRAGMENT, this.panel ? panelMaterial(material, this.panel.radius) : material]) this.programs.push(this.program(vertex, frag));
    this.vao = gl.createVertexArray()!; gl.bindVertexArray(this.vao);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    for (let i = 0; i < 4; i++) {
      const texture = gl.createTexture()!; this.textures.push(texture); gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      if (i > 0) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.roi.width, this.roi.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        const fb = gl.createFramebuffer()!; this.targets.push(fb); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('局部帧缓冲不可用');
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.disable(gl.BLEND);
    this.ink = new AdaptiveInk(gl, this.contentPixels.width, this.contentPixels.height, this.size, onTones, [pad, pad]);
  }
  private program(v: string, f: string) {
    const gl = this.gl, program = gl.createProgram()!;
    for (const [type, source] of [[gl.VERTEX_SHADER, v], [gl.FRAGMENT_SHADER, f]] as const) {
      const shader = gl.createShader(type)!; gl.shaderSource(shader, source); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) { const message = gl.getShaderInfoLog(shader); gl.deleteShader(shader); throw new Error('Shader: ' + message); }
      gl.attachShader(program, shader); gl.deleteShader(shader);
    }
    gl.linkProgram(program); if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('WebGL link: ' + gl.getProgramInfoLog(program));
    return program;
  }
  draw(video: HTMLVideoElement, geometry: Geometry, upload: boolean, mode: Mode, settings: MaterialSettings, revision: number, reduced = false, changed = upload, motion: MotionPose = REST_POSE, sources?: GlassSource[], blurSigmaOverride?: number) {
    if (mode !== 'B' && mode !== 'C') throw new Error('采集关闭时不可绘制材质');
    const gl = this.gl, begin = performance.now();
    if (gl.isContextLost()) throw new Error('WebGL 上下文已丢失');
    this.pollQueries();
    const q = this.ext && this.queries.length < 8 ? gl.createQuery() : null;
    if (q) gl.beginQuery(this.ext!.TIME_ELAPSED_EXT, q);
    gl.activeTexture(gl.TEXTURE0); gl.bindVertexArray(this.vao);
    gl.bindTexture(gl.TEXTURE_2D, this.textures[0]);
    // Chromium imports the video frame; no PNG, Base64, drawImage or readPixels.
    if (upload && !sources) {
      const uploadStart = performance.now();
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
      this.uploadTimes.push(performance.now() - uploadStart); if (this.uploadTimes.length > 120) this.uploadTimes.shift();
    }
    gl.viewport(0, 0, this.roi.width, this.roi.height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.targets[0]); gl.useProgram(this.programs[0]);
    if (!sources) { gl.uniform4fv(gl.getUniformLocation(this.programs[0], 'region'), regionUV(geometry)); gl.drawArrays(gl.TRIANGLES, 0, 3); }
    else {
      // Keep prepared screen textures for the lifetime of this visible material
      // session. Switching displays must not allocate the same textures again.
      const sample = { x: geometry.window.x - SAMPLE_PAD, y: geometry.window.y - SAMPLE_PAD, width: this.size.width + SAMPLE_PAD * 2, height: this.size.height + SAMPLE_PAD * 2 };
      for (const [i, source] of sources.entries()) {
        let entry = this.displayTextures.get(source.video);
        if (!entry) {
          entry = { texture: gl.createTexture()!, frame: -1 }; this.displayTextures.set(source.video, entry);
          gl.bindTexture(gl.TEXTURE_2D, entry.texture);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        } else gl.bindTexture(gl.TEXTURE_2D, entry.texture);
        if (entry.frame !== source.frame) { const at = performance.now(); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source.video); this.uploadTimes.push(performance.now() - at); if (this.uploadTimes.length > 120) this.uploadTimes.shift(); entry.frame = source.frame; }
        // First source extends the physical desktop edge. Other screens replace
        // only their own ROI pixels; different DPI is handled by the UV ratios.
        if (i) {
          const clip = intersection(sample, source.display); if (!clip) continue;
          const x = Math.round((clip.x - sample.x) / sample.width * this.roi.width), right = Math.round((clip.x + clip.width - sample.x) / sample.width * this.roi.width);
          const top = Math.round((clip.y - sample.y) / sample.height * this.roi.height), bottom = Math.round((clip.y + clip.height - sample.y) / sample.height * this.roi.height);
          gl.enable(gl.SCISSOR_TEST); gl.scissor(x, this.roi.height - bottom, right - x, bottom - top);
        }
        gl.uniform4fv(gl.getUniformLocation(this.programs[0], 'region'), regionUV({ ...geometry, display: source.display })); gl.drawArrays(gl.TRIANGLES, 0, 3); gl.disable(gl.SCISSOR_TEST);
      }
    }
    const useFrost = mode === 'C' && settings.blur && settings.adaptiveFrost && settings.debugView === 'normal';
    if (useFrost) {
      if (!this.frost) { this.frost = new AdaptiveFrost(gl, this.panel); this.frost.layoutChanged(this.readingRects); }
      this.frost.draw(this.textures[1], [this.size.width + SAMPLE_PAD * 2, this.size.height + SAMPLE_PAD * 2], settings.blurSigma, settings.frostSigma, settings.frostThreshold, reduced, changed, performance.now(), settings.frostTransitionMs, settings.regionalFrost, [settings.frostWeightStatus, settings.frostWeightPrimary, settings.frostWeightIcons, settings.frostWeightEmpty]);
    } else this.frost?.stop();
    gl.bindVertexArray(this.vao); gl.viewport(0, 0, this.roi.width, this.roi.height);
    gl.useProgram(this.programs[1]);
    gl.uniform1f(gl.getUniformLocation(this.programs[1], 'sigma'), blurSigmaOverride ?? (mode === 'C' ? settings.blurSigma : 2.5));
    gl.uniform1i(gl.getUniformLocation(this.programs[1], 'source'), 0);
    gl.uniform1i(gl.getUniformLocation(this.programs[1], 'adaptiveFrost'), useFrost ? 1 : 0);
    gl.uniform1f(gl.getUniformLocation(this.programs[1], 'maximumSigma'), settings.frostSigma);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.frost?.texture ?? this.textures[1]);
    gl.uniform1i(gl.getUniformLocation(this.programs[1], 'frost'), 2); gl.activeTexture(gl.TEXTURE0);
    const blurStep = mode === 'C' && !settings.blur ? 0 : this.dpr;
    for (let i = 0; i < 2; i++) {
      gl.bindTexture(gl.TEXTURE_2D, this.textures[i + 1]); gl.bindFramebuffer(gl.FRAMEBUFFER, this.targets[i + 1]);
      gl.uniform2f(gl.getUniformLocation(this.programs[1], 'stepSize'), i === 0 ? blurStep / this.roi.width : 0, i === 1 ? blurStep / this.roi.height : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.programs[2]); gl.bindTexture(gl.TEXTURE_2D, this.textures[3]);
    gl.uniform1i(gl.getUniformLocation(this.programs[2], 'source'), 0);
    gl.uniform2f(gl.getUniformLocation(this.programs[2], 'outputOffset'), this.contentPixels.x, this.contentPixels.y);
    gl.uniform1i(gl.getUniformLocation(this.programs[2], 'elevation'), settings.elevation ? 1 : 0);
    gl.uniform3f(gl.getUniformLocation(this.programs[2], 'elevationProfile'), settings.fresnelRange, settings.fresnelHardness, settings.shadowSpread);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.textures[1]);
    gl.uniform1i(gl.getUniformLocation(this.programs[2], 'sharp'), 1); gl.activeTexture(gl.TEXTURE0);
    const branchUniform = gl.getUniformLocation(this.programs[2], 'fullMaterial');
    if (!branchUniform) throw new Error('材质分支 uniform 不可用');
    gl.uniform1i(branchUniform, mode === 'C' ? 1 : 0);
    const uniform = (name: string) => {
      const location = gl.getUniformLocation(this.programs[2], name);
      if (!location) throw new Error(`材质参数 ${name} 不可用`); return location;
    };
    gl.uniform4fv(uniform('motionShape'), motion.shape);
    gl.uniform1f(uniform('motionGain'), motion.gain);
    gl.uniform2fv(uniform('motionLocal'), motion.localLight);
    gl.uniform1f(uniform('motionElevation'), motion.elevation);
    gl.uniform3fv(uniform('motionContact'), motion.contact);
    gl.uniform2fv(uniform('motionRipple'), motion.ripple);
    gl.uniform2fv(uniform('motionTug'), motion.tug);
    gl.uniform2fv(uniform('motionFeedback'), motion.feedbackRing);
    gl.uniform1f(uniform('motionEnergy'), motion.energy);
    gl.uniform1f(uniform('motionInflation'), motion.inflation);
    gl.uniform2fv(uniform('motionLightField'), motion.lightField);
    this.motionApplied = { elevation: motion.elevation, gain: motion.gain, shape: [...motion.shape], localLight: [...motion.localLight], contact: [...motion.contact], ripple: [...motion.ripple], tug: [...motion.tug], feedbackRing: [...motion.feedbackRing], energy: motion.energy, inflation: motion.inflation, lightField: [...motion.lightField] };
    const surface = uniform('surface'), optics = uniform('optics'), finish = uniform('finish'), light = uniform('lightDirection'), debugView = uniform('debugView');
    gl.uniform4f(surface, settings.highlight ? settings.highlightStrength : 0, settings.highlightWidth, settings.highlight ? settings.fresnelStrength : 0, settings.shade ? settings.lowerShade : 0);
    gl.uniform4f(optics, settings.edgeWidth, settings.ior, settings.refraction ? settings.refractionPx : 0, settings.tint ? settings.tintStrength : 0);
    gl.uniform2f(finish, settings.contour ? settings.contourStrength : 0, settings.shadow ? settings.shadowStrength : 0);
    const angle = settings.lightAngle * Math.PI / 180;
    gl.uniform2f(light, Math.cos(angle), Math.sin(angle));
    const point = screenLightPosition(geometry);
    gl.uniform3fv(uniform('lightPosition'), point);
    gl.uniform1i(uniform('screenLight'), settings.screenLight ? 1 : 0);
    const distance = distanceLight(geometry, settings);
    const distanceUniform = uniform('distanceProfile');
    gl.uniform3f(distanceUniform, distance.height, distance.radius, distance.blend);
    const lensUniform=uniform('planoLens'); gl.uniform1i(lensUniform,settings.planoLens ? 1 : 0);
    const centerUniform=uniform('centerBalance'); gl.uniform1i(centerUniform,settings.centerBalance ? 1 : 0);
    this.lighting = { screenCenter: settings.screenLight, localPoint: point, distanceModel: distance };
    const glare = uniform('glareProfile'), dual = uniform('dualLight');
    gl.uniform4f(glare, settings.oppositeHighlight, settings.glareConvergence, settings.dispersion && settings.refraction ? settings.dispersionPx : 0, settings.dualLight ? settings.glareChroma : 0);
    gl.uniform1i(dual, settings.dualLight ? 1 : 0);
    const balance = uniform('lightBalance'); gl.uniform1f(balance, settings.lightBalance);
    gl.uniform1i(debugView, settings.debugView === 'highlight' ? 1 : settings.debugView === 'refraction' ? 2 : 0);
    if (revision !== this.appliedMaterialRevision) {
      this.uniformReadback = { surface: Array.from(gl.getUniform(this.programs[2], surface)), optics: Array.from(gl.getUniform(this.programs[2], optics)), finish: Array.from(gl.getUniform(this.programs[2], finish)), light: Array.from(gl.getUniform(this.programs[2], light)), glare: Array.from(gl.getUniform(this.programs[2], glare)), dualLight: Number(gl.getUniform(this.programs[2], dual)), lightBalance: Number(gl.getUniform(this.programs[2], balance)), distance: Array.from(gl.getUniform(this.programs[2], distanceUniform)), planoLens: Number(gl.getUniform(this.programs[2], lensUniform)), centerBalance: Number(gl.getUniform(this.programs[2], centerUniform)), debugView: Number(gl.getUniform(this.programs[2], debugView)) };
      this.appliedMaterialRevision = revision;
      this.uniformReadback.elevation = Number(gl.getUniform(this.programs[2], uniform('elevation')));
      this.uniformReadback.elevationProfile = Array.from(gl.getUniform(this.programs[2], uniform('elevationProfile')));
      this.uniformReadback.contentPixels = Object.values(this.contentPixels);
    }
    if (mode !== this.lastMode) { this.materialBranch = Number(gl.getUniform(this.programs[2], branchUniform)); this.lastMode = mode; }
    gl.uniform2f(gl.getUniformLocation(this.programs[2], 'size'), this.size.width, this.size.height);
    gl.uniform2f(gl.getUniformLocation(this.programs[2], 'roiSize'), this.size.width + SAMPLE_PAD * 2, this.size.height + SAMPLE_PAD * 2);
    gl.uniform1f(gl.getUniformLocation(this.programs[2], 'dpr'), this.dpr);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const adaptive = mode === 'C' && settings.adaptiveText && settings.debugView === 'normal';
    const spatial = adaptive && settings.spatialText && !!this.maskSource;
    this.ink.sample(adaptive && !spatial);
    if (spatial && !this.spatial) this.spatial = new SpatialInk(gl, this.contentPixels.width, this.contentPixels.height, this.maskSource!, [this.contentPixels.x, this.contentPixels.y], 40, this.size, this.panel ? 16 : 6);
    this.spatial?.draw(spatial, reduced, changed);
    if (q) { gl.endQuery(this.ext!.TIME_ELAPSED_EXT); this.queries.push(q); }
    return performance.now() - begin;
  }
  private pollQueries() {
    const gl = this.gl;
    if (!this.ext) return;
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
    while (this.queries.length && gl.getQueryParameter(this.queries[0], gl.QUERY_RESULT_AVAILABLE)) {
      const q = this.queries.shift()!;
      if (!disjoint) { this.gpuTimes.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6); if (this.gpuTimes.length > 120) this.gpuTimes.shift(); }
      gl.deleteQuery(q);
    }
  }
  loseContext() { this.gl.getExtension('WEBGL_lose_context')?.loseContext(); }
  get sourceTextureBytes() { return [...this.displayTextures.keys()].reduce((sum, video) => sum + video.videoWidth * video.videoHeight * 4, 0); }
  dispose() {
    this.frost?.dispose();
    this.spatial?.dispose();
    this.ink.dispose();
    const gl = this.gl;
    for (const entry of this.displayTextures.values()) gl.deleteTexture(entry.texture); this.displayTextures.clear();
    for (const q of this.queries) gl.deleteQuery(q);
    for (const t of this.textures) gl.deleteTexture(t);
    for (const fb of this.targets) gl.deleteFramebuffer(fb);
    for (const p of this.programs) gl.deleteProgram(p);
    gl.deleteVertexArray(this.vao); this.loseContext();
  }
}
