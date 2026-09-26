// Electron 44 routes getDisplayMedia through a preliminary "media" request with
// an empty mediaTypes array. Camera/microphone requests carry video/audio types.
// The subsequent display handler still checks the frame, selected display, audio
// exclusion, visibility and mandatory material-host capture protection before
// granting a source. The preference for other windows does not affect this gate.
export function allowCapturePermission(capsule: boolean, enabled: boolean, permission: string, mediaTypes?: string[]) {
  return capsule && enabled && (permission === 'display-capture' || (permission === 'media' && Array.isArray(mediaTypes) && mediaTypes.length === 0));
}
