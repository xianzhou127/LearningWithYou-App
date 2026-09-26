import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { DesktopSession, type MediaPort } from "../session";
import { createCloudServices, type LearningServices } from "../services";
import { AsrClientError } from "../../shared/asr-errors";
import { getFinalTranscript, type TranscriptUpdate } from "../../shared/transcript";
import type { AnalysisInput, AnalysisResponse } from "../../shared/analysis-contract";
import type { Shot } from "../shared";

function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const tick = () => new Promise(resolve => setImmediate(resolve));
async function fixture() {
  const jpg = await sharp({ create: { width: 80, height: 60, channels: 3, background: "#d5e4c8" } }).jpeg().toBuffer();
  const shot: Shot = { dataUrl: `data:image/jpeg;base64,${jpg.toString("base64")}`, width: 80, height: 60, capturedAt: 1, frameTime: 1 };
  const events: string[] = [], requests: { input: AnalysisInput; signal: AbortSignal; model: string | undefined }[] = [];
  const callbacks: { update: (v: TranscriptUpdate) => void; fail: (error: AsrClientError) => void }[] = [];
  const env = { DASHSCOPE_API_KEY: "synthetic-secret", QWEN_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1", QWEN_MODEL: "qwen3.8-max", ANALYSIS_OUTPUT_MODE: "text" };
  const options = { finalText: "电流相同，电压按电阻分配。", empty: false, startGate: null as ReturnType<typeof deferred<void>> | null, finishGate: null as ReturnType<typeof deferred<void>> | null, responseGate: null as ReturnType<typeof deferred<AnalysisResponse>> | null, failure: false };
  const services: LearningServices = createCloudServices(() => ({ ...env }));
  services.asr = (_config, update, fail) => {
    callbacks.push({ update, fail }); const n = callbacks.length;
    return {
      start: async () => { events.push("connect"); await options.startGate?.promise; events.push("ready"); },
      send: () => events.push("pcm"),
      finish: async () => { events.push("asr-finish"); await options.finishGate?.promise; if (!options.empty) update({ id: 1, text: options.finalText, final: true }); events.push("final"); },
      cancel: () => events.push(`cancel-asr-${n}`),
    };
  };
  const validate = services.validate; services.validate = async value => { events.push("validate"); return validate(value); };
  services.analyze = async (input, config, signal) => {
    events.push("analyze"); requests.push({ input: { ...input }, signal, model: config.QWEN_MODEL });
    if (options.responseGate) return options.responseGate.promise;
    if (options.failure) return { ok: false, error: { code: "model_timeout", message: "超时", retryable: true } };
    return { ok: true, mode: "text", result: { message: "- 本轮理解正确\n\n最后一行（无句末标点）" }, details: null };
  };
  const port: MediaPort = { call: async command => {
    events.push(command.type);
    if (command.type === "select") return { type: "selected" };
    if (command.type === "start") {
      assert.ok(session.receivePcm({ ...command, sequence: 0, bytes: new ArrayBuffer(3200) }));
      return { type: "started", start: shot, startedAt: Date.now() };
    }
    if (command.type === "finish") {
      events.push("microphone-stopped"); session.handleMediaEvent({ ...command, kind: "recording-stopped" });
      events.push("end-screenshot"); assert.ok(session.receivePcm({ ...command, sequence: 1, bytes: new ArrayBuffer(2) })); events.push("tail-acked");
      return { type: "finished", end: { ...shot, capturedAt: 2, frameTime: 2 }, lastSequence: 1, audio: { bytes: new ArrayBuffer(16), mime: "audio/webm", durationMs: 1000, pcm: { sampleRate: 16000, inputSampleRate: 48000, samples: 1601, frames: 2, maxDeliveryGapMs: 1, seconds: [] } } };
    }
    return { type: "cleared" };
  } };
  const session = new DesktopSession(port, () => events.push("quit"), services);
  await session.select({ id: "window:123:0", name: "专用测试资料", kind: "window" });
  return { session, services, callbacks, options, env, requests, events };
}
test("real sequence: connect before microphone; stop, screenshot, tail ack, final transcript, decode, one analysis", async () => {
  const f = await fixture(); f.options.finishGate = deferred();
  await f.session.start(f.session.snapshot().revision);
  f.callbacks[0].update({ id: 1, text: "电流", final: false }); f.callbacks[0].update({ id: 1, text: "电流相同", final: false });
  const revision = f.session.snapshot().revision, work = f.session.check(revision);
  assert.equal((await f.session.check(revision)).ok, false); await tick();
  assert.equal(f.session.snapshot().phase, "transcribing"); assert.equal(f.session.snapshot().recording, false); assert.equal(f.requests.length, 0);
  f.options.finishGate.resolve(); await work;
  for (const [before, after] of [["connect", "ready"], ["ready", "start"], ["microphone-stopped", "end-screenshot"], ["end-screenshot", "tail-acked"], ["tail-acked", "asr-finish"], ["final", "validate"], ["validate", "analyze"]]) assert.ok(f.events.indexOf(before) < f.events.indexOf(after), before + " before " + after);
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].input.transcript, f.options.finalText);
  assert.equal(f.session.snapshot().transcriptComplete, true); assert.equal(f.session.snapshot().transcript.interimSentence, null);
  assert.equal(f.session.snapshot().analysis?.ok, true); assert.equal(f.session.snapshot().phase, "feedback");
});
test("analysis retry uses identical screenshots and transcript, new request id and repaired configuration only", async () => {
  const f = await fixture(); f.options.failure = true;
  await f.session.start(f.session.snapshot().revision); await f.session.check(f.session.snapshot().revision);
  const before = f.session.snapshot(); assert.equal(before.retryable, true);
  f.env.QWEN_MODEL = "qwen3.8-flash"; f.options.failure = false;
  const events = f.events.length; const revision = f.session.snapshot().revision;
  await Promise.all([f.session.retry(revision), f.session.retry(revision)]);
  assert.equal(f.requests.length, 2); assert.deepEqual(f.requests[0].input, f.requests[1].input); assert.equal(f.requests[1].model, "qwen3.8-flash");
  assert.equal(f.session.snapshot().requestId, before.requestId + 1); assert.deepEqual(f.events.slice(events), ["analyze"]);
});

test("T16 round snapshots config at start; edits during recording/analysis only affect next round or explicit retry", async () => {
  const f = await fixture();
  await f.session.start(f.session.snapshot().revision);
  f.env.QWEN_MODEL = "org/next-model:1";
  await f.session.check(f.session.snapshot().revision);
  assert.equal(f.requests[0].model, "qwen3.8-max");
  await f.session.start(f.session.snapshot().revision);
  f.options.responseGate = deferred(); const pending = f.session.check(f.session.snapshot().revision);
  while (f.requests.length < 2) await tick();
  f.env.QWEN_MODEL = "third-model";
  assert.equal(f.requests[1].model, "org/next-model:1");
  f.options.responseGate.resolve({ ok: false, error: { code: "model_timeout", message: "超时", retryable: true } }); await pending;
  f.options.responseGate = null;
  await f.session.retry(f.session.snapshot().revision);
  assert.equal(f.requests[2].model, "third-model"); assert.deepEqual(f.requests[2].input, f.requests[1].input);
});
test("empty, oversized or unconfirmed transcript never initiates analysis and cannot retry", async () => {
  for (const kind of ["empty", "oversized", "interim"]) {
    const f = await fixture();
    if (kind === "oversized") f.options.finalText = "知".repeat(8001);
    else f.options.empty = true;
    await f.session.start(f.session.snapshot().revision);
    if (kind === "interim") f.callbacks[0].update({ id: 1, text: "未确认", final: false });
    await f.session.check(f.session.snapshot().revision);
    assert.equal(f.requests.length, 0); assert.equal(f.session.snapshot().phase, "error"); assert.equal(f.session.snapshot().retryable, false);
    assert.equal((await f.session.retry(f.session.snapshot().revision)).ok, false);
  }
});
test("ASR failures retain clearly incomplete text, stop resources and never trigger model or reconnection", async () => {
  const f = await fixture(); await f.session.start(f.session.snapshot().revision);
  f.callbacks[0].update({ id: 1, text: "只有部分", final: true });
  f.callbacks[0].fail(new AsrClientError("network-interruption", "网络中断")); await tick();
  assert.equal(f.session.snapshot().errorStage, "asr"); assert.equal(f.session.snapshot().recording, false);
  assert.equal(f.session.snapshot().transcriptComplete, false); assert.equal(f.session.snapshot().retryable, false);
  assert.match(getFinalTranscript(f.session.snapshot().transcript), /部分/); assert.equal(f.requests.length, 0); assert.equal(f.callbacks.length, 1); assert.ok(f.events.includes("cancel"));
});
test("cancel during ASR startup prevents late readiness from opening a microphone", async () => {
  const f = await fixture(); f.options.startGate = deferred();
  const work = f.session.start(f.session.snapshot().revision); assert.equal(f.session.snapshot().phase, "connecting");
  await f.session.cancel(); f.options.startGate.resolve(); await work;
  assert.equal(f.events.includes("start"), false); assert.equal(f.session.snapshot().phase, "ready");
});
test("cancel, next round and source replacement isolate late ASR and model callbacks", async () => {
  const f = await fixture(); await f.session.start(f.session.snapshot().revision); const old = f.session.snapshot();
  f.options.responseGate = deferred(); const work = f.session.check(f.session.snapshot().revision);
  while (!f.requests.length) await tick();
  await f.session.cancel(); assert.equal(f.requests[0].signal.aborted, true);
  await f.session.select({ id: "window:456:0", name: "新资料", kind: "window" });
  await f.session.start(f.session.snapshot().revision);
  f.callbacks[0].update({ id: 1, text: "旧句子", final: true }); f.callbacks[0].fail(new AsrClientError("service-error", "旧错误"));
  assert.equal(f.session.receivePcm({ ...old, sequence: 2, bytes: new ArrayBuffer(2) }), false);
  f.options.responseGate.resolve({ ok: true, mode: "text", result: { message: "旧回答" }, details: null }); await work;
  assert.equal(f.session.snapshot().feedback, null); assert.equal(getFinalTranscript(f.session.snapshot().transcript), ""); assert.equal(f.session.snapshot().phase, "recording"); await f.session.quit();
});
test("three continuous rounds, hidden recording, explicit end and quit release the shared session", async () => {
  const f = await fixture();
  for (let round = 0; round < 3; round++) {
    f.options.finalText = `第${round + 1}轮最终句。`;
    await f.session.start(f.session.snapshot().revision); if (round === 1) f.session.setHidden(true);
    await f.session.check(f.session.snapshot().revision);
    assert.equal(f.requests[round].input.transcript, f.options.finalText); assert.equal(f.session.snapshot().phase, "feedback");
    f.session.setHidden(false);
  }
  assert.equal(f.events.filter(e => e === "select").length, 1); assert.equal(f.callbacks.length, 3);
  await f.session.cancel(true); assert.equal(f.session.snapshot().phase, "idle"); assert.equal(f.session.snapshot().source, null); assert.equal(f.session.snapshot().feedback, null); assert.deepEqual(f.session.artifacts(), {});
  await Promise.all([f.session.quit(), f.session.quit()]); assert.equal(f.events.filter(e => e === "quit").length, 1);
});
test("source disconnect during analysis aborts transport and suppresses late feedback", async () => {
  const f = await fixture(); await f.session.start(f.session.snapshot().revision); f.options.responseGate = deferred();
  const work = f.session.check(f.session.snapshot().revision); while (!f.requests.length) await tick();
  f.session.handleMediaEvent({ ...f.session.snapshot(), kind: "source-ended" }); await tick();
  f.options.responseGate.resolve({ ok: true, mode: "text", result: { message: "迟到" }, details: null }); await work;
  assert.equal(f.requests[0].signal.aborted, true); assert.equal(f.session.snapshot().source, null); assert.equal(f.session.snapshot().feedback, null);
});
