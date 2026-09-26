import assert from "node:assert/strict";
import { test } from "node:test";
import { DesktopSession, type MediaPort } from "../session";
import { parseAction, parseView, roleCanAct, trustedFrame, validMediaEvent, validReply } from "../security";
import type { MediaValue, Shot } from "../shared";
import { simulatedServices } from "./fakes";

const source = { id: "window:123:0", name: "Test material", kind: "window" as const };
const shot: Shot = { dataUrl: "data:image/jpeg;base64,AAAA", width: 640, height: 480, capturedAt: Date.now(), frameTime: 1 };
const audio = { bytes: new ArrayBuffer(8), mime: "audio/webm;codecs=opus", durationMs: 61000, pcm: { sampleRate: 16000, inputSampleRate: 48000, samples: 976000, frames: 12000, maxDeliveryGapMs: 10, seconds: [{ second: 0, samples: 16000, rms: 0.2 }] } };
function deferred<T>() { let resolve!: (v: T) => void, reject!: (e: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture(delay = 10) {
  const calls: string[] = []; let next: ReturnType<typeof deferred<MediaValue>> | null = null; let exited = 0;
  const port: MediaPort = { call: async command => {
    calls.push(command.type);
    if (next && command.type !== "cancel" && command.type !== "dispose") { const task = next; next = null; return task.promise; }
    if (command.type === "select") return { type: "selected" };
    if (command.type === "start") return { type: "started", start: shot, startedAt: Date.now() };
    if (command.type === "finish") return { type: "finished", end: { ...shot, frameTime: 2 }, audio, lastSequence: -1 };
    return { type: "cleared" };
  } };
  return { session: new DesktopSession(port, () => exited++, simulatedServices(delay)), calls, defer: () => (next = deferred<MediaValue>()), exits: () => exited };
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
test("selection prepares a stream; it never starts a microphone or a round", async () => {
  const f = fixture(); await f.session.select(source);
  assert.deepEqual(f.calls, ["dispose", "select"]); assert.equal(f.session.snapshot().phase, "ready"); assert.equal(f.session.snapshot().recording, false); assert.deepEqual(f.session.artifacts(), {});
});
test("synchronous lock rejects repeated start from two windows", async () => {
  const f = fixture(); await f.session.select(source); const d = f.defer(); const revision = f.session.snapshot().revision;
  const start = f.session.start(revision); assert.equal((await f.session.start(revision)).ok, false);
  d.resolve({ type: "started", start: shot, startedAt: Date.now() }); await start;
  assert.equal(f.calls.filter(x => x === "start").length, 1); await f.session.cancel();
});
test("duplicate check yields one finish and one local demo result", async () => {
  const f = fixture(); await f.session.select(source); await f.session.start(f.session.snapshot().revision); const revision = f.session.snapshot().revision;
  await Promise.all([f.session.check(revision), f.session.check(revision)]); await sleep(20);
  assert.equal(f.calls.filter(x => x === "finish").length, 1); assert.match(f.session.snapshot().feedback!, /演示反馈，未调用 AI/); assert.equal(f.session.snapshot().recording, false);
});
test("stale UI cannot start a new round", async () => {
  const f = fixture(); await f.session.select(source); const old = f.session.snapshot().revision; f.session.setHidden(true);
  assert.equal((await f.session.start(old)).ok, false); assert.equal(f.calls.includes("start"), false);
});
test("hiding and restoring do not create or stop any media", async () => {
  const f = fixture(); await f.session.select(source); await f.session.start(f.session.snapshot().revision);
  const before = [...f.calls]; for (let i = 0; i < 20; i++) { f.session.setHidden(true); f.session.setHidden(false); }
  assert.deepEqual(f.calls, before); assert.equal(f.session.snapshot().recording, true); assert.equal(f.session.snapshot().hiddenIntervals.length, 20); await f.session.cancel();
});
test("late start cannot revive a cancelled round", async () => {
  const f = fixture(); await f.session.select(source); const d = f.defer(); const start = f.session.start(f.session.snapshot().revision);
  await f.session.cancel(); d.resolve({ type: "started", start: shot, startedAt: Date.now() }); await start;
  assert.equal(f.session.snapshot().phase, "ready"); assert.equal(f.session.snapshot().recording, false); assert.deepEqual(f.session.artifacts(), {});
});
test("late source selection cannot replace a newer source", async () => {
  const f = fixture(); const d = f.defer(); const first = f.session.select(source); await sleep(1); await f.session.cancel();
  await f.session.select({ ...source, id: "window:456:0" }); d.resolve({ type: "selected" }); await first;
  assert.equal(f.session.snapshot().source?.id, "window:456:0");
});
test("old source-ended event cannot end a replacement session", async () => {
  const f = fixture(); await f.session.select(source); const old = f.session.snapshot(); await f.session.select({ ...source, id: "window:456:0" });
  f.session.handleMediaEvent({ sessionId: old.sessionId, roundId: old.roundId, kind: "source-ended" });
  assert.equal(f.session.snapshot().phase, "ready");
});
test("old microphone callbacks cannot alter a new round", async () => {
  const f = fixture(); await f.session.select(source); await f.session.start(f.session.snapshot().revision); const old = f.session.snapshot(); await f.session.cancel(); await f.session.start(f.session.snapshot().revision);
  f.session.handleMediaEvent({ sessionId: old.sessionId, roundId: old.roundId, kind: "microphone-ended" }); assert.equal(f.session.snapshot().phase, "recording"); await f.session.cancel();
});
test("current source closure clears source and stops recording", async () => {
  const f = fixture(); await f.session.select(source); await f.session.start(f.session.snapshot().revision); const s = f.session.snapshot(); f.session.handleMediaEvent({ sessionId: s.sessionId, roundId: s.roundId, kind: "source-ended" }); await sleep(1);
  assert.equal(f.session.snapshot().source, null); assert.equal(f.session.snapshot().recording, false); assert.equal(f.session.snapshot().phase, "error"); assert.equal(f.calls.at(-1), "dispose");
});
test("cannot change source while recording", async () => {
  const f = fixture(); await f.session.select(source); await f.session.start(f.session.snapshot().revision);
  assert.equal((await f.session.select({ ...source, id: "window:456:0" })).ok, false); await f.session.cancel();
});
test("cancel during delayed demo prevents late feedback", async () => {
  const f = fixture(); await f.session.select(source); await f.session.start(f.session.snapshot().revision); await f.session.check(f.session.snapshot().revision); await f.session.cancel(); await sleep(25);
  assert.equal(f.session.snapshot().feedback, null); assert.deepEqual(f.session.artifacts(), {});
});
test("three rounds reuse one source with fresh screenshots and recordings", async () => {
  const f = fixture(); await f.session.select(source);
  for (let i = 0; i < 3; i++) { await f.session.start(f.session.snapshot().revision); assert.equal(f.session.snapshot().feedback, null); await f.session.check(f.session.snapshot().revision); await sleep(20); assert.equal(f.session.snapshot().phase, "feedback"); assert.equal(f.session.artifacts().end?.frameTime, 2); }
  assert.equal(f.calls.filter(x => x === "select").length, 1); assert.equal(f.calls.filter(x => x === "start").length, 3); assert.equal(f.calls.filter(x => x === "finish").length, 3);
});
test("microphone refusal clears audio and permits retry", async () => {
  const f = fixture(); await f.session.select(source); const d = f.defer(); const work = f.session.start(f.session.snapshot().revision); d.reject(new Error("denied")); await work;
  assert.equal(f.session.snapshot().phase, "error"); assert.match(f.session.snapshot().error!, /拒绝/); assert.equal(f.session.snapshot().recording, false); assert.equal(f.calls.at(-1), "cancel");
  assert.equal((await f.session.start(f.session.snapshot().revision)).ok, true); await f.session.cancel();
});
test("finish failure stops microphone and never creates demo feedback", async () => {
  const f = fixture(); await f.session.select(source); await f.session.start(f.session.snapshot().revision); const d = f.defer(); const work = f.session.check(f.session.snapshot().revision); d.reject(new Error("source")); await work; await sleep(20);
  assert.equal(f.session.snapshot().recording, false); assert.equal(f.session.snapshot().feedback, null); assert.equal(f.calls.at(-1), "cancel");
});
test("exit preempts start, releases once, ignores late reply", async () => {
  const f = fixture(); await f.session.select(source); const d = f.defer(); const start = f.session.start(f.session.snapshot().revision);
  await Promise.all([f.session.quit(), f.session.quit()]); d.resolve({ type: "started", start: shot, startedAt: Date.now() }); await start;
  assert.equal(f.exits(), 1); assert.equal(f.session.snapshot().phase, "exiting"); assert.equal(f.session.snapshot().source, null); assert.equal(f.session.snapshot().recording, false);
});
test("IPC accepts only exact local top-level role URLs", () => {
  assert.equal(trustedFrame("learning://app/index.html?role=menu", "menu", true), true);
  for (const url of ["https://app/index.html?role=menu", "learning://app.evil/index.html?role=menu", "learning://app/index.html?role=panel", "learning://app/index.html?role=menu#x"]) assert.equal(trustedFrame(url, "menu", true), false);
  assert.equal(trustedFrame("learning://app/index.html?role=menu", "menu", false), false);
});
test("IPC commands reject extra fields, source spoofing, arbitrary APIs", () => {
  assert.deepEqual(parseAction({ type: "start", revision: 1 }), { type: "start", revision: 1 });
  for (const action of [null, {}, { type: "start", revision: -1 }, { type: "start", revision: 1, exec: "x" }, { type: "select", sourceId: "file:///secret" }, { type: "shell", revision: 1 }]) assert.throws(() => parseAction(action));
  assert.equal(roleCanAct("orb", { type: "start", revision: 1 }), true); assert.equal(roleCanAct("orb", { type: "select", sourceId: source.id }), false); assert.equal(roleCanAct("history", { type: "start", revision: 1 }), false); assert.equal(roleCanAct("panel", { type: "select", sourceId: source.id }), false); assert.equal(roleCanAct("picker", { type: "select", sourceId: source.id }), true);
  assert.throws(() => parseView("openExternal"));
});
test("media boundary rejects malformed payload and oversized metadata", () => {
  assert.equal(validReply({ id: 1, value: { type: "started", start: shot, startedAt: Date.now() } }), true);
  assert.equal(validReply({ id: 1, value: { type: "finished", end: shot, audio, lastSequence: -1 } }), true);
  assert.equal(validReply({ id: 1, value: { type: "started", start: { ...shot, dataUrl: "javascript:alert(1)" }, startedAt: Date.now() } }), false);
  assert.equal(validReply({ id: 1, value: { type: "finished", end: shot, audio: { ...audio, mime: "text/html" } } }), false);
  assert.equal(validReply({ id: 1, error: "denied", value: { type: "cleared" } }), false);
  assert.equal(validMediaEvent({ sessionId: 1, roundId: 1, kind: "source-ended" }), true);
  assert.equal(validMediaEvent({ sessionId: 1, roundId: NaN, kind: "source-ended" }), false);
});
