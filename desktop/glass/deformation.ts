// A single smooth influence over the full capsule length. Forward displacement
// points WITH the force, strongest at contact; the far end remains attached.
// Keep CPU foreground/input and GPU inverse surface mappings identical.
export function pullWeight(x: number, contactX: number) {
  const span = Math.max(contactX - 6, 315 - contactX, 1);
  const t = Math.min(1, Math.abs(x - contactX) / span);
  return 1 - t * t * (3 - 2 * t);
}
export function pullOffset(x: number, contactX: number, tug: readonly number[]): [number, number] {
  const w = pullWeight(x, contactX);
  if (!w) return [0, 0];
  return [tug[0] ? tug[0] * w : 0, tug[1] ? -tug[1] * w : 0]; // DOM Y downward
}
export function pullSlope(x: number, contactX: number) {
  const span = Math.max(contactX - 6, 315 - contactX, 1);
  const t = Math.min(1, Math.abs(x - contactX) / span);
  return -6 * t * (1 - t) * Math.sign(x - contactX) / span;
}
// The centreline's horizontal stretch is d(x + tugX*w)/dx. Its reciprocal
// narrows an extended section and thickens a compressed one. This preserves
// local 2D area until the readability/sampling limits engage, not 3D volume.
// Vertical motion remains the accepted continuous shear/bend; no extra spring.
export function pullCrossScale(x: number, contactX: number, tug: readonly number[]) {
  return Math.max(.78, Math.min(1.18, 1 / (1 + tug[0] * pullSlope(x, contactX))));
}
export function unpull(x: number, y: number, contactX: number, tug: readonly number[], centerY = 26) {
  let qx = x;
  // Monotone map at every allowed contact/force. Newton also covers centre
  // previews, where the shorter influence span made five fixed-point steps
  // less accurate. Solve X before undoing bend and transverse strain in Y.
  for (let i = 0; i < 4; i++) qx -= (qx + tug[0] * pullWeight(qx, contactX) - x) / (1 + tug[0] * pullSlope(qx, contactX));
  const [, dy] = pullOffset(qx, contactX, tug);
  return [qx, centerY + (y - dy - centerY) / pullCrossScale(qx, contactX, tug)];
}
export const PULL_GLSL = `
float pullWeight(float x,float contactX){
  float span=max(max(contactX-6.,315.-contactX),1.);
  float t=clamp(abs(x-contactX)/span,0.,1.);
  return 1.-t*t*(3.-2.*t);
}
float pullSlope(float x,float contactX){
  float span=max(max(contactX-6.,315.-contactX),1.);
  float t=clamp(abs(x-contactX)/span,0.,1.);
  return -6.*t*(1.-t)*sign(x-contactX)/span;
}
float pullCrossScale(float x,float contactX,vec2 tug){
  return clamp(1./(1.+tug.x*pullSlope(x,contactX)),.78,1.18);
}
vec2 unpull(vec2 p,vec2 tug,float contactX,float centerY){
  float x=p.x;
  for(int i=0;i<4;i++)x-=(x+tug.x*pullWeight(x,contactX)-p.x)/(1.+tug.x*pullSlope(x,contactX));
  float y=centerY+(p.y-tug.y*pullWeight(x,contactX)-centerY)/pullCrossScale(x,contactX,tug);
  return vec2(x,y);
}`;
