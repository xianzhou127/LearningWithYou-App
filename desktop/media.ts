import type { MediaCommand, MediaReply, MediaValue, PcmStats, Recording, Shot, MediaEvent } from "./shared";
import { PcmSender } from "./pcm-sender";

// One stable DOM realm owns all streams; no media object crosses the bridge.
const host = window.mediaHost;
const video = document.querySelector("video")!;
let generation = 0;
let sourceSession = 0;
let round = 0;
let display: MediaStream | null = null;
let microphone: MediaStream | null = null;
let recorder: MediaRecorder | null = null;
let audioContext: AudioContext | null = null;
let worklet: AudioWorkletNode | null = null;
let input: MediaStreamAudioSourceNode | null = null;
let sink: GainNode | null = null;
let chunks: Blob[] = [];
let startedAt = 0;
let stats: PcmStats = emptyStats();
let stopping = false;
let lastPcmDelivery = 0;
let chunkBytes = 0;
let abortWork: AbortController | null = null;
let pcmSender: PcmSender | null = null;
let flushComplete: (() => void) | null = null;
function emptyStats(): PcmStats { return { sampleRate: 16000, inputSampleRate: 0, samples: 0, frames: 0, maxDeliveryGapMs: 0, seconds: [] }; }
function assertCurrent(g: number) { if (generation !== g) throw new Error("cancelled"); }
function notify(kind: MediaEvent["kind"], sessionId = sourceSession, roundId = round) { host.event({ kind, sessionId, roundId }); }
function bounded<T>(task: Promise<T>, signal: AbortSignal, late?: (value: T) => void, ms = 12000): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, value?: T) => {
      if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(value as T);
    };
    const abort = () => finish(new Error("cancelled"));
    const timer = setTimeout(() => finish(new Error("timeout")), ms);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    task.then(value => { if (settled) late?.(value); else finish(undefined, value); }, error => {
      void error;
      finish(new Error("denied"));
    });
  });
}
async function stopAudio() {
  stopping = true;
  pcmSender?.cancel(); pcmSender = null; flushComplete = null;
  if (recorder) {
    recorder.onstop = null; recorder.onerror = null; recorder.ondataavailable = null;
    if (recorder.state !== "inactive") recorder.stop(); recorder = null;
  }
  microphone?.getTracks().forEach(track => { track.onended = null; track.stop(); }); microphone = null;
  if (worklet) { worklet.port.onmessage = null; worklet.disconnect(); worklet = null; }
  input?.disconnect(); input = null; sink?.disconnect(); sink = null;
  const context = audioContext; audioContext = null;
  chunks = []; chunkBytes = 0;
  if (context && context.state !== "closed") await context.close();
}
async function clear(all: boolean) {
  const g = ++generation; abortWork?.abort(); abortWork = null;
  const audioStopped = stopAudio();
  if (all) {
    display?.getTracks().forEach(track => { track.onended = null; track.stop(); });
    display = null; video.srcObject = null;
  }
  await audioStopped; return g;
}
async function capture(g: number, signal: AbortSignal): Promise<Shot> {
  if (display?.getVideoTracks()[0]?.readyState !== "live") throw new Error("source");
  // Wait for a frame delivered after the action; never fall back to picker thumbnails or an old canvas.
  const frame = await new Promise<number>((resolve, reject) => {
    const done = (error?: Error, time?: number) => {
      video.cancelVideoFrameCallback(callback); clearTimeout(timer); signal.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(time!);
    };
    const abort = () => done(new Error("cancelled"));
    const timer = setTimeout(() => done(new Error("source")), 5000);
    const callback = video.requestVideoFrameCallback((_now, metadata) => done(undefined, metadata.mediaTime));
    signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
  });
  assertCurrent(g);
  const width = video.videoWidth, height = video.videoHeight;
  if (!width || !height || width > 8192 || height > 8192) throw new Error("source");
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
  const context = canvas.getContext("2d"); if (!context) throw new Error("source");
  context.drawImage(video, 0, 0);
  return { dataUrl: canvas.toDataURL("image/jpeg", 0.92), width, height, capturedAt: Date.now(), frameTime: frame };
}
function receivePcm(buffer: ArrayBuffer) {
  pcmSender?.push(buffer);
  const now = performance.now();
  if (lastPcmDelivery) stats.maxDeliveryGapMs = Math.max(stats.maxDeliveryGapMs, now - lastPcmDelivery);
  lastPcmDelivery = now; stats.frames++;
  const pcm = new Int16Array(buffer);
  for (const sample of pcm) {
    const second = Math.floor(stats.samples / 16000);
    if (second > 659) { notify("media-error"); return; }
    const bucket = stats.seconds[second] ?? (stats.seconds[second] = { second, samples: 0, rms: 0 });
    // Accumulate squares until finish; conversion to RMS happens only once in final result.
    bucket.rms += (sample / 32768) ** 2; bucket.samples++; stats.samples++;
  }
}
async function execute(command: MediaCommand): Promise<MediaValue> {
  if (command.type === "dispose" || command.type === "cancel") {
    await clear(command.type === "dispose"); return { type: "cleared" };
  }
  if (command.type === "select") {
    const g = await clear(true); assertCurrent(g); sourceSession = command.sessionId; round = command.roundId;
    const controller = new AbortController(); abortWork = controller;
    const stream = await bounded(navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 12 }, audio: false }), controller.signal, s => s.getTracks().forEach(t => t.stop()));
    if (generation !== g) { stream.getTracks().forEach(t => t.stop()); throw new Error("cancelled"); }
    display = stream; const sourceTrack = stream.getVideoTracks()[0];
    if (!sourceTrack) throw new Error("source");
    const id = sourceSession;
    sourceTrack.onended = () => { if (display === stream) { void stopAudio(); notify("source-ended", id, round); } };
    video.srcObject = stream; video.muted = true;
    await bounded(video.play(), controller.signal); assertCurrent(g);
    return { type: "selected" };
  }
  if (command.sessionId !== sourceSession) throw new Error("cancelled");
  if (command.type === "start") {
    const g = await clear(false); assertCurrent(g); round = command.roundId; stopping = false;
    const controller = new AbortController(); abortWork = controller;
    const start = await capture(g, controller.signal);
    const mic = await bounded(navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false }), controller.signal, s => s.getTracks().forEach(t => t.stop()));
    if (generation !== g) { mic.getTracks().forEach(t => t.stop()); throw new Error("cancelled"); }
    microphone = mic;
    const audioTrack = mic.getAudioTracks()[0]; if (!audioTrack || audioTrack.readyState !== "live") throw new Error("audio");
    audioTrack.onended = () => { if (generation === g && !stopping) notify("microphone-ended"); };
    audioContext = new AudioContext(); stats = emptyStats(); stats.inputSampleRate = audioContext.sampleRate;
    const context = audioContext;
    await bounded(context.audioWorklet.addModule("./pcm-worklet.js"), controller.signal); assertCurrent(g);
    input = context.createMediaStreamSource(mic);
    pcmSender = new PcmSender(sourceSession, round, packet => host.pcm(packet), () => { if (generation === g) notify("pcm-error"); });
    worklet = new AudioWorkletNode(context, "pcm16-downsampler", { processorOptions: { targetSampleRate: 16000 } });
    worklet.port.onmessage = event => {
      if (generation !== g) return;
      if (event.data.type === "audio") receivePcm(event.data.buffer);
      else if (event.data.type === "flushed") flushComplete?.();
      else notify("media-error");
    };
    sink = context.createGain(); sink.gain.value = 0;
    input.connect(worklet); worklet.connect(sink); sink.connect(context.destination);
    await bounded(context.resume(), controller.signal); assertCurrent(g);
    recorder = new MediaRecorder(mic, { mimeType: "audio/webm;codecs=opus" });
    const currentRecorder = recorder; chunks = []; chunkBytes = 0; lastPcmDelivery = 0;
    recorder.ondataavailable = event => {
      if (generation !== g || recorder !== currentRecorder) return;
      if (event.data.size) { chunks.push(event.data); chunkBytes += event.data.size; }
      if (chunkBytes > 30 * 1024 * 1024) notify("media-error");
    };
    recorder.onerror = () => { if (generation === g) notify("media-error"); };
    recorder.onstop = () => { if (generation === g && !stopping) notify("media-error"); };
    recorder.start(1000); startedAt = Date.now();
    return { type: "started", start, startedAt };
  }
  const g = generation; const signal = abortWork!.signal;
  if (!recorder || recorder.state !== "recording" || command.roundId !== round) throw new Error("audio");
  stopping = true; const finalRecorder = recorder; const durationMs = Date.now() - startedAt;
  // Stop the physical input first. Preserve the worklet and listener until its final message.
  microphone?.getTracks().forEach(track => { track.onended = null; track.stop(); });
  microphone = null;
  input?.disconnect();
  notify("recording-stopped");
  const sender = pcmSender;
  const flushed = bounded(new Promise<void>((resolve, reject) => {
    if (!worklet || !sender) { reject(new Error("audio")); return; }
    flushComplete = resolve; worklet.port.postMessage({ type: "flush" });
  }), signal, undefined, 6000);
  const pcmTask = flushed.then(() => sender!.drain());
  const endTask = capture(g, signal);
  // Install both settlements before stopping, so capture failures cannot become unhandled rejections.
  const audioTask = (async () => {
    await bounded(new Promise<void>((resolve, reject) => { finalRecorder.onstop = () => resolve(); finalRecorder.onerror = () => reject(new Error("audio")); finalRecorder.stop(); }), signal, undefined, 6000);
    assertCurrent(g);
    const blob = new Blob(chunks, { type: "audio/webm;codecs=opus" });
    const bytes = await blob.arrayBuffer(); assertCurrent(g);
    await pcmTask; assertCurrent(g);
    if (!bytes.byteLength || !stats.samples) throw new Error("audio");
    const pcm = structuredClone(stats); pcm.seconds.forEach(s => { s.rms = Math.sqrt(s.rms / s.samples); });
    const audio: Recording = { bytes, mime: blob.type, durationMs, pcm };
    await stopAudio(); return audio;
  })();
  const [end, audio, lastSequence] = await Promise.all([endTask, audioTask, pcmTask]); assertCurrent(g);
  return { type: "finished", end, audio, lastSequence };
}
host.onCommand(command => {
  void execute(command).then(value => host.reply({ id: command.id, value }), async error => {
    const name = error instanceof Error ? error.message : "audio";
    // A superseded operation must never clean up a newer stream.
    if (name !== "cancelled") await clear(false);
    const code = ["denied", "source", "audio", "timeout", "cancelled"].includes(name) ? name : "audio";
    host.reply({ id: command.id, error: code as MediaReply["error"] });
  });
});
window.addEventListener("beforeunload", () => { void clear(true); });
host.ready();
