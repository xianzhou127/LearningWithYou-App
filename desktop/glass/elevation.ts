// SDF edge-reflection / shadow controls inspired by the pinned upstream shaders.
// Artistic screen-space profiles, not a ray-traced Fresnel or caustics solver.
// Includes strength-5 contour stretch, lift and finite shadow support.
// Fixed allocation includes the maximum live-tuned bubble and shadow envelope.
export const ELEVATION_PAD = 96;
export const ELEVATION_GLSL = `
float capsuleSdf(vec2 p){vec2 q=abs(p)-vec2(134.5,0.);return length(max(q,0.))+min(max(q.x,q.y),0.)-20.;}
float rimReflection(float depth,float range,float hardness){
  // Upstream fifth-power shoulder, normalized so range remains the inward
  // support width. Hardness fills out the rim without brightening the centre.
  return pow(clamp((1.-depth/max(range,.001))/(1.-.75*hardness),0.,1.),5.);
}
float diffuseShadow(vec2 p,vec2 offset,float sigma){
  float d=max(capsuleSdf(p-offset),0.);
  // Finite smooth support: exactly transparent beyond 3 sigma, no tile edge.
  return exp(-.5*d*d/(sigma*sigma))*(1.-smoothstep(2.5*sigma,3.*sigma,d));
}`;
