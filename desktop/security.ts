import { APP_ORIGIN, MAX_PCM_PACKET_BYTES, type PcmPacket, type Action, type Role, type ViewAction, type MediaReply, type MediaEvent } from "./shared";

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const integer = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
export function trustedFrame(actual: string, expected: Role, top: boolean) {
  return top && actual === `${APP_ORIGIN}/${expected === "media" ? "media" : expected === "orb" || expected === "appearance" ? "glass" : "index"}.html?role=${expected}`;
}
export function parseAction(v: unknown): Action {
  if (!object(v)) throw new Error("Invalid action");
  if (v.type === "select" && typeof v.sourceId === "string" && /^(window|screen):\d+:\d+$/.test(v.sourceId) && v.sourceId.length < 100 && Object.keys(v).length === 2) return v as Action;
  if (["start", "check", "retry", "cancel", "end", "quit"].includes(String(v.type)) && integer(v.revision) && Object.keys(v).length === 2) return v as Action;
  throw new Error("Invalid action");
}
export function parseView(v: unknown): ViewAction {
  if (typeof v === "string" && ["hover-enter", "hover-leave", "toggle-menu", "toggle-feedback", "operation-failed", "move-left", "move-right", "move-up", "move-down", "collapse", "feedback", "feedback-inactive", "panel", "settings", "picker", "history", "hide", "restore", "close", "minimize", "toggle-maximize"].includes(v)) return v as ViewAction;
  throw new Error("Invalid view action");
}
export function roleCanAct(role: Role, action: Action) {
  return action.type === "select" ? role === "picker" : ["orb", "menu", "panel", "feedback"].includes(role);
}
export function roleCanControlWindow(role: Role) {
  return ["picker", "history", "panel", "settings"].includes(role);
}
function validShot(v: unknown) {
  return object(v) && typeof v.dataUrl === "string" && v.dataUrl.length < 24 * 1024 * 1024 && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(v.dataUrl)
    && integer(v.width) && Number(v.width) > 0 && Number(v.width) <= 8192 && integer(v.height) && Number(v.height) > 0 && Number(v.height) <= 8192
    && integer(v.capturedAt) && typeof v.frameTime === "number" && Number.isFinite(v.frameTime);
}
export function validReply(v: unknown): v is MediaReply {
  if (!object(v) || !integer(v.id)) return false;
  if (v.error !== undefined) return ["denied", "source", "audio", "timeout", "cancelled"].includes(String(v.error)) && v.value === undefined;
  if (!object(v.value)) return false;
  const r = v.value;
  if (r.type === "selected" || r.type === "cleared") return true;
  if (r.type === "started") return validShot(r.start) && integer(r.startedAt);
  if (r.type !== "finished" || !validShot(r.end) || !object(r.audio) || !Number.isSafeInteger(r.lastSequence) || Number(r.lastSequence) < -1) return false;
  const a = r.audio;
  if (!(a.bytes instanceof ArrayBuffer || ArrayBuffer.isView(a.bytes)) || (a.bytes as ArrayBuffer).byteLength > 32 * 1024 * 1024 || (a.bytes as ArrayBuffer).byteLength === 0
    || typeof a.mime !== "string" || !/^audio\/webm(?:;codecs=opus)?$/.test(a.mime) || typeof a.durationMs !== "number" || !Number.isFinite(a.durationMs) || a.durationMs < 0 || a.durationMs > 660000 || !object(a.pcm)) return false;
  const p = a.pcm;
  return p.sampleRate === 16000 && typeof p.inputSampleRate === "number" && p.inputSampleRate >= 16000 && p.inputSampleRate <= 384000
    && integer(p.samples) && integer(p.frames) && typeof p.maxDeliveryGapMs === "number" && Number.isFinite(p.maxDeliveryGapMs)
    && Array.isArray(p.seconds) && p.seconds.length <= 660 && p.seconds.every(s => object(s) && integer(s.second) && integer(s.samples) && typeof s.rms === "number" && s.rms >= 0 && s.rms <= 1);
}
export function validMediaEvent(v: unknown): v is MediaEvent {
  return object(v) && integer(v.sessionId) && integer(v.roundId) && ["source-ended", "microphone-ended", "media-error", "recording-stopped", "pcm-error"].includes(String(v.kind));
}
export function validPcmPacket(v: unknown): v is PcmPacket {
  return object(v) && Object.keys(v).length === 4 && integer(v.sessionId) && integer(v.roundId) && integer(v.sequence)
    && v.bytes instanceof ArrayBuffer && v.bytes.byteLength > 0 && v.bytes.byteLength % 2 === 0 && v.bytes.byteLength <= MAX_PCM_PACKET_BYTES;
}
// Fixed resources only; never convert renderer-controlled paths to filesystem paths.
export const staticFiles: Record<string, { file: string; mime: string }> = {
  "/glass.html": { file: "glass.html", mime: "text/html" },
  "/glass.js": { file: "glass.js", mime: "text/javascript" },
  "/glass.css": { file: "glass.css", mime: "text/css" },
  "/index.html": { file: "index.html", mime: "text/html" },
  "/media.html": { file: "media.html", mime: "text/html" },
  "/ui.js": { file: "ui.js", mime: "text/javascript" },
  "/ui.css": { file: "ui.css", mime: "text/css" },
  "/media.js": { file: "media.js", mime: "text/javascript" },
  "/pcm-worklet.js": { file: "pcm-worklet.js", mime: "text/javascript" },
};
