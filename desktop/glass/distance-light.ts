import type { Geometry } from './contract';
import type { MaterialSettings } from './material-settings';
import { screenLightPosition } from './geometry';

export function distanceLight(g: Geometry, settings: MaterialSettings) {
  const position = screenLightPosition(g);
  const height = Math.max(80, Math.min(g.display.width, g.display.height) * settings.lightHeight);
  const radius = height * settings.lightRadius;
  const distance = Math.hypot(position[0], position[1], height);
  return {
    height, radius, blend: settings.screenLight ? settings.distanceEffect : 0,
    distance, relativeEnergy: height * height / (distance * distance),
    angularRadiusDeg: Math.asin(radius / distance) * 180 / Math.PI,
  };
}

// Original implementation of standard GGX/Smith/Schlick equations and Karis's
// sphere representative-point + normalization approximation. See UPSTREAM.md.
// Shared with the numeric GPU probe; no texture access or fragment readback.
export const DISTANCE_LIGHT_GLSL = `
const float PI=3.14159265359;
vec3 srgbToLinear(vec3 c){
  return mix(c/12.92,pow((c+.055)/1.055,vec3(2.4)),step(vec3(.04045),c));
}
vec3 linearToSrgb(vec3 c){
  c=max(c,vec3(0.));
  return mix(c*12.92,1.055*pow(c,vec3(1./2.4))-.055,step(vec3(.0031308),c));
}
// A continuous elliptical cap over the capsule's medial line: height rises from
// the silhouette to the centre. Its normal never needs a 2D light direction.
vec4 convexCap(vec2 outward,float depth,float width){
  float radial=clamp(1.-depth/20.,0.,1.);
  float vertical=sqrt(max(1.-radial*radial,0.));
  float rise=clamp(width*2.,.5,12.);
  vec3 n=normalize(vec3(outward*rise*radial,20.*vertical));
  return vec4(n,rise*vertical);
}
float smithG1(float cosine,float alpha){
  return 2.*cosine/max(cosine+sqrt(alpha*alpha+(1.-alpha*alpha)*cosine*cosine),.00001);
}
float schlickFresnel(float cosine,float ior){
  if(ior<=1.000001) return 0.;
  float f0=(ior-1.)/(ior+1.); f0*=f0;
  return f0+(1.-f0)*pow(1.-clamp(cosine,0.,1.),5.);
}
// Incident energy uses sphere-centre distance; shifting the representative
// direction does NOT change attenuation. Normalization compensates for widening.
vec2 sphereKernel(vec3 n,vec3 toLight,float radius,float alpha,float height){
  float distance2=max(dot(toLight,toLight),1.);
  float distance=sqrt(distance2);
  vec3 view=vec3(0.,0.,1.);
  vec3 reflected=reflect(-view,n);
  vec3 towardRay=reflected*max(dot(toLight,reflected),0.)-toLight;
  vec3 representative=toLight+towardRay*min(radius/max(length(towardRay),.00001),1.);
  vec3 light=normalize(representative);
  float nv=max(n.z,0.),nl=max(dot(n,light),0.);
  if(nv<.00001 || nl<.00001) return vec2(0.,1.);
  vec3 halfway=normalize(light+view);
  float nh=max(dot(n,halfway),0.);
  float a2=alpha*alpha;
  float denominator=nh*nh*(a2-1.)+1.;
  float distribution=a2/(PI*denominator*denominator);
  float widened=min(1.,alpha+radius/(3.*distance));
  float normalization=(alpha*alpha)/(widened*widened);
  float masking=smithG1(nv,alpha)*smithG1(nl,alpha);
  float irradiance=height*height/distance2;
  // BRDF times N.L: cosine cancels its denominator, with horizon guarded above.
  return vec2(distribution*normalization*masking*irradiance/(4.*nv),max(dot(view,halfway),0.));
}
float sphereReflection(vec3 n,vec3 toLight,float radius,float alpha,float ior,float height){
  vec2 kernel=sphereKernel(n,toLight,radius,alpha,height);
  return kernel.x*schlickFresnel(kernel.y,ior);
}
float distanceReflection(vec2 outward,float depth,float width,vec3 toCentre,
  float radius,float height,float ior,float convergence,float opposite,float balance){
  vec4 cap=convexCap(outward,depth,width);
  vec3 toLight=toCentre-vec3(0.,0.,cap.w);
  float alpha=clamp(.14*sqrt(2./convergence),.07,.34);
  float front=sphereReflection(cap.xyz,toLight,radius,alpha,ior,height);
  // Explicit stylized secondary reflection, not an internal ray trace.
  vec3 reverseNormal=vec3(-cap.xy,cap.z);
  float back=opposite>0. ? sphereReflection(reverseNormal,toLight,radius,alpha*mix(1.,.7,balance),ior,height) : 0.;
  float edgeWeight=.18+.82*pow(clamp(1.-depth/20.,0.,1.),.65);
  return 8.*edgeWeight*(front*(1.+.2*balance)+back*opposite*(1.-.75*balance));
}
// A planar back at z=0 and one aspheric top. The longitudinal envelope prevents
// the entire middle segment from sharing a cylinder's identical surface normal.
vec4 planoCap(vec2 p,vec2 outward,float depth,float width){
  float radial=clamp(1.-depth/20.,0.,1.);
  float transverse2=max(1.-radial*radial,0.);
  // Keep this envelope positive at the end caps: making both factors vanish
  // there flattens their product and collapses the reflective curved shoulder.
  float longitudinal2=max(1.-.75*p.x*p.x/(154.5*154.5),.25);
  float rise=clamp(width*2.,.5,12.);
  float elevation=sqrt(transverse2*longitudinal2);
  vec2 slope=rise*(longitudinal2*radial*outward/20.
    +vec2(.75*transverse2*p.x/(154.5*154.5),0.));
  return vec4(normalize(vec3(slope,elevation)),rise*elevation);
}
float dielectricFresnel(float cosine,float fromIOR,float toIOR){
  if(abs(fromIOR-toIOR)<.000001) return 0.;
  cosine=clamp(cosine,0.,1.);
  float eta=fromIOR/toIOR;
  float transmitted2=1.-eta*eta*(1.-cosine*cosine);
  if(transmitted2<=0.) return 1.;
  float ct=sqrt(transmitted2);
  float rs=(fromIOR*cosine-toIOR*ct)/max(fromIOR*cosine+toIOR*ct,.000001);
  float rp=(toIOR*cosine-fromIOR*ct)/max(toIOR*cosine+fromIOR*ct,.000001);
  return .5*(rs*rs+rp*rp);
}
// Deliberate UI rim support, not another traced light. It compensates for the
// disappearing legacy direction near the source projection without coating the
// transparent body. Use capsule-centre distance so the long axis gets no bands.
float centreRimSupport(vec2 sourceProjection,float height,float depth,float width,
  float strength,float blend,float ior){
  float reach=.4*height;
  float proximity=exp(-dot(sourceProjection,sourceProjection)/(reach*reach));
  float rim=exp(-depth/clamp(.6*width,.45,2.));
  float f0=dielectricFresnel(1.,1.,ior);
  float interfaceScale=clamp(f0/.03012089,0.,1.5);
  // Intermediate settings retain the old centre-fading lobe, so compensate
  // that missing rim more than at the fully physical endpoint. Zero stays zero.
  float exposure=.16+.6*(1.-blend);
  return blend*(1.-exp(-strength*exposure*interfaceScale*proximity*rim));
}
vec3 balanceReflectedColor(vec3 legacy,vec3 planoLinear,vec3 reflected,float blend,float support){
  return linearToSrgb(mix(mix(srgbToLinear(legacy),planoLinear,blend),srgbToLinear(reflected),support));
}
vec2 planoReflection(vec2 p,vec2 outward,float depth,float width,vec3 toCentre,
  float radius,float height,float ior,float convergence,float opposite,float balance){
  if(ior<=1.000001) return vec2(0.);
  vec4 cap=planoCap(p,outward,depth,width);
  vec3 n=cap.xyz,view=vec3(0.,0.,1.);
  vec3 toLight=toCentre-vec3(0.,0.,cap.w);
  float alpha=clamp(.14*sqrt(2./convergence),.07,.34);
  // Constant emitter radiance instead of constant power: a smaller source must
  // not amplify its radiance without bound. 4 is a fixed UI exposure convention.
  float sourceScale=4.*PI*radius*radius/(height*height);
  float entryF=dielectricFresnel(n.z,1.,ior);
  vec2 frontKernel=sphereKernel(n,toLight,radius,alpha,height);
  // The representative-point approximation is not a full BSDF integral. Use a
  // conservative per-interface reflectance budget so it cannot whiten the body.
  float front=min(entryF,frontKernel.x*dielectricFresnel(frontKernel.y,1.,ior)*sourceScale);
  float back=0.;
  if(opposite>0.){
    // Reciprocal local path: viewer -> curved entry -> flat back -> curved exit.
    // Evaluate exit at the same local tangent; no claim of spatial ray tracing.
    vec3 inside=refract(-view,n,1./ior);
    vec3 bounced=reflect(inside,vec3(0.,0.,1.));
    vec3 exiting=refract(bounced,-n,ior);
    if(dot(bounced,n)>0. && dot(exiting,exiting)>.000001 && exiting.z>-.999){
      float backF=dielectricFresnel(abs(inside.z),ior,1.);
      float exitF=dielectricFresnel(max(dot(bounced,n),0.),ior,1.);
      float budget=(1.-entryF)*backF*(1.-exitF);
      vec3 virtualNormal=normalize(view+exiting);
      vec2 backKernel=sphereKernel(virtualNormal,toLight,radius,alpha,height);
      back=budget*clamp(backKernel.x*sourceScale,0.,1.)
        *min(opposite,1.)*(1.-.75*balance);
    }
  }
  return vec2(front,min(back,1.-front));
}
`;
