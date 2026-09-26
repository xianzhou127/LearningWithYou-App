// Menu adapter for the accepted capsule material. Optical equations, lighting,
// blur, foreground and saved parameters remain shared; only the outline changes.
export function panelMaterial(source: string, radius: number) {
  return source.replace('vec2 q=abs(p)-vec2(134.5,0.);return length(max(q,0.))+min(max(q.x,q.y),0.)-20.;',
    `vec2 q=abs(p)-(size*.5-vec2(${radius.toFixed(3)}));return length(max(q,0.))+min(max(q.x,q.y),0.)-${radius.toFixed(3)};`)
    .replace('if(motionContact.z!=0. || dot(motionTug,motionTug)>0.)', 'if(true)');
}
