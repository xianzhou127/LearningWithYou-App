import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HistoryStore } from "../history";
import { DesktopSession, type MediaPort } from "../session";
import { simulatedServices } from "./fakes";
import type { Artifacts, Shot } from "../shared";
import type { AnalysisResponse } from "../../shared/analysis-contract";

const shot = (text: string): Shot => ({ dataUrl: `data:image/jpeg;base64,${Buffer.from(text).toString("base64")}`, width: 20, height: 20, capturedAt: Date.now(), frameTime: 1 });
const materials = (n: number): Artifacts => ({ start: shot(`start-${n}`), end: shot(`end-${n}`), audio: { bytes: Uint8Array.from([n, 2, 3, 4]).buffer, mime: "audio/webm", durationMs: n * 1000, pcm: { sampleRate: 16000, inputSampleRate: 48000, samples: 0, frames: 0, maxDeliveryGapMs: 0, seconds: [] } } });
async function fixture(t: TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lwy-t12-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, store: new HistoryStore(dir) };
}
function gate<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function sessionFixture(store: HistoryStore) {
  let n = 0, exits = 0;
  const services = simulatedServices();
  const media: MediaPort = { call: async command => {
    if (command.type === "select") return { type: "selected" };
    if (command.type === "start") { n++; return { type: "started", start: materials(n).start!, startedAt: Date.now() + n }; }
    if (command.type === "finish") return { type: "finished", end: materials(n).end!, audio: materials(n).audio!, lastSequence: -1 };
    return { type: "cleared" };
  } };
  services.asr = (_config, update) => ({ start: async () => {}, send: () => {}, finish: async () => { update({ id: 1, text: `最终转写 ${n}`, final: true }); }, cancel: () => {} });
  services.analyze = async () => ({ ok: true, mode: "text", result: { message: `# 反馈 ${n}\n\n**已取得**` }, details: null });
  const session = new DesktopSession(media, () => exits++, services, store);
  return { session, services, exits: () => exits };
}
const source = { id: "window:123:0", name: "专用合成资料", kind: "window" as const };

test("three distinct session rounds persist corresponding materials once; restart reads originals", async t => {
  const { dir, store } = await fixture(t); const { session } = sessionFixture(store);
  await session.select(source);
  for (let n = 1; n <= 3; n++) { await session.start(session.snapshot().revision); await session.check(session.snapshot().revision); }
  await session.cancel(true); assert.equal(await store.flush(), true);
  const fresh = new HistoryStore(dir), list = await fresh.list(); assert.equal(list.total, 3);
  for (let i = 0; i < 3; i++) {
    const n = 3 - i, item = list.items[i], d = await fresh.detail(item.id);
    assert.equal(d.record?.transcript, `最终转写 ${n}`); assert.equal(d.record?.feedback?.message, `# 反馈 ${n}\n\n**已取得**`);
    assert.equal(d.record?.durationMs, n * 1000); assert.equal(d.record?.stage, "complete");
    assert.deepEqual(d.available, { start: true, end: true, audio: true });
    assert.equal(await (await fresh.media(item.id, "start", null)).text(), `start-${n}`);
    assert.equal(await (await fresh.media(item.id, "end", null)).text(), `end-${n}`);
    assert.deepEqual(Buffer.from(await (await fresh.media(item.id, "audio", null)).arrayBuffer()), Buffer.from([n, 2, 3, 4]));
    const json = await readFile(path.join(fresh.directory, item.id, "record.json"), "utf8"); assert.doesNotMatch(json, /pcm|timings|DASHSCOPE|configuration|diagnostics|requestId/);
  }
});
test("analysis failure keeps final materials; retry updates the same ID", async t => {
  const { store } = await fixture(t), { session, services } = sessionFixture(store);
  services.analyze = async () => ({ ok: false, error: { code: "model_unavailable", message: "unavailable", retryable: true } });
  await session.select(source); await session.start(session.snapshot().revision); await session.check(session.snapshot().revision); await store.flush();
  const first = (await store.list()).items[0]; assert.equal(first.stage, "failed"); assert.equal(first.locked, false);
  assert.equal((await store.detail(first.id)).record?.transcript, "最终转写 1");
  services.analyze = async () => ({ ok: true, mode: "text", result: { message: "retry **success**" }, details: null });
  await session.retry(session.snapshot().revision); await store.flush();
  assert.equal((await store.list()).total, 1); assert.equal((await store.detail(first.id)).record?.feedback?.message, "retry **success**");
});
test("late analysis callbacks and queued writes stay bound to their original round", async t => {
  const { store } = await fixture(t), { session, services } = sessionFixture(store), response = gate<AnalysisResponse>();
  services.analyze = () => response.promise;
  await session.select(source); await session.start(session.snapshot().revision); const checking = session.check(session.snapshot().revision);
  while (session.snapshot().phase !== "processing") await new Promise(resolve => setImmediate(resolve));
  await session.cancel(); services.analyze = async () => ({ ok: true, mode: "text", result: { message: "second" }, details: null });
  await session.start(session.snapshot().revision); await session.check(session.snapshot().revision);
  response.resolve({ ok: true, mode: "text", result: { message: "stale first" }, details: null }); await checking; await store.flush();
  const list = await store.list(); assert.equal(list.total, 2);
  const second = await store.detail(list.items[0].id), first = await store.detail(list.items[1].id);
  assert.equal(second.record?.feedback?.message, "second"); assert.equal(first.record?.feedback, null); assert.equal(first.record?.stage, "interrupted");
});
test("ASR failure never archives interim or partial final sentences as final transcript", async t => {
  const { store } = await fixture(t), { session, services } = sessionFixture(store);
  services.asr = (_config, update) => ({ start: async () => {}, send: () => {}, cancel: () => {}, finish: async () => { update({ id: 1, text: "partial", final: true }); update({ id: 2, text: "interim", final: false }); throw new Error("ASR failed"); } });
  await session.select(source); await session.start(session.snapshot().revision); await session.check(session.snapshot().revision); await store.flush();
  const d = await store.detail((await store.list()).items[0].id); assert.equal(d.record?.transcript, null); assert.equal(d.record?.feedback, null); assert.equal(d.available.audio, true); assert.equal(d.record?.stage, "failed");
});
test("crash-style reopen marks unfinished metadata interrupted while retaining available start", async t => {
  const { dir, store } = await fixture(t); const round = store.begin("start only", Date.now(), true); round.update({}, { start: shot("start") }); await store.flush();
  const d = await new HistoryStore(dir).detail(round.record.id); assert.equal(d.record?.stage, "interrupted"); assert.equal(d.available.start, true); assert.equal(d.available.audio, false); assert.equal(d.record?.transcript, null);
});
test("atomic metadata failure preserves previous version and current AI feedback; exit retries then waits", async t => {
  const { store } = await fixture(t), f = sessionFixture(store);
  const io = store as unknown as { atomic(file: string, bytes: Uint8Array | string): Promise<void> };
  const original = io.atomic.bind(store); let fail = false;
  io.atomic = async (file, bytes) => { if (fail && file.endsWith("record.json")) throw new Error("injected disk failure"); await original(file, bytes); };
  await f.session.select(source); await f.session.start(f.session.snapshot().revision); await store.flush(); fail = true;
  await f.session.check(f.session.snapshot().revision); assert.equal(await store.flush(), false);
  const list = await store.list(); assert.equal(list.total, 1); assert.equal((await store.detail(list.items[0].id)).record?.feedback, null);
  assert.match(f.session.snapshot().feedback!, /反馈 1/); assert.equal(f.session.snapshot().phase, "feedback"); assert.ok(store.error);
  assert.equal((await f.session.quit()).ok, false); assert.equal(f.exits(), 0); assert.match(f.session.snapshot().feedback!, /反馈 1/);
  fail = false; assert.equal((await f.session.quit()).ok, true); assert.equal(f.exits(), 1); assert.equal(store.error, null);
  assert.match((await store.detail(list.items[0].id)).record!.feedback!.message, /反馈 1/);
});
test("missing attachment, corrupt record and unknown version do not poison the list", async t => {
  const { store } = await fixture(t); const rounds = [0, 1, 2, 3].map(n => { const r = store.begin(`round ${n}`, Date.now() + n, true); r.update({ stage: "failed" }, materials(n + 1)); r.settle(); return r; }); await store.flush();
  await rm(path.join(store.directory, rounds[0].record.id, "end.jpg"));
  await writeFile(path.join(store.directory, rounds[1].record.id, "record.json"), "{");
  await writeFile(path.join(store.directory, rounds[2].record.id, "record.json"), JSON.stringify({ ...rounds[2].record, version: 999 }));
  const list = await store.list(); assert.equal(list.total, 4); assert.equal(list.items.filter(i => i.corrupt).length, 2);
  assert.equal((await store.detail(rounds[0].record.id)).available.end, false); assert.equal((await store.detail(rounds[3].record.id)).available.end, true);
});
test("pagination reads metadata, never attachment bodies; media supports bounded ranges", async t => {
  const { store } = await fixture(t);
  for (let i = 0; i < 31; i++) { const r = store.begin(`round ${i}`, i, true); r.update({ stage: "failed" }, materials(1)); r.settle(); } await store.flush();
  const first = await store.list(), second = await store.list(30); assert.equal(first.items.length, 30); assert.equal(first.nextOffset, 30); assert.equal(second.items.length, 1);
  const response = await store.media(first.items[0].id, "audio", "bytes=1-2"); assert.equal(response.status, 206); assert.equal(response.headers.get("Content-Range"), "bytes 1-2/4"); assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from([2, 3]));
  assert.equal((await store.media(first.items[0].id, "audio", "bytes=99-")).status, 416);
});
test("active and queued records cannot delete; clear rejects busy sessions", async t => {
  const { store } = await fixture(t); const r = store.begin("busy", 1, true); r.update({}, materials(1));
  await assert.rejects(store.delete(r.record.id)); await assert.rejects(store.clear(async () => true, () => false));
  r.settle(); await store.flush(); await assert.rejects(store.clear(async () => true, () => true));
  await store.delete(r.record.id); assert.equal((await store.list()).total, 0);
  r.update({ transcript: "late" }); await store.flush(); assert.equal((await store.list()).total, 0);
});
test("delete races current retry without resurrecting an ID, including restart", async t => {
  const { dir, store } = await fixture(t), { session, services } = sessionFixture(store);
  services.analyze = async () => ({ ok: false, error: { code: "model_unavailable", message: "unavailable", retryable: true } });
  await session.select(source); await session.start(session.snapshot().revision); await session.check(session.snapshot().revision); await store.flush();
  const id = (await store.list()).items[0].id, deletion = store.delete(id);
  services.analyze = async () => ({ ok: true, mode: "text", result: { message: "current only" }, details: null });
  await session.retry(session.snapshot().revision); await deletion; await store.flush();
  assert.equal(session.snapshot().feedback, "current only"); assert.equal((await new HistoryStore(dir).list()).total, 0);
});
test("clear confirmation has exact count, cancellation changes nothing, starts blocked until release", async t => {
  const { dir, store } = await fixture(t), { session } = sessionFixture(store); await session.select(source);
  for (let i = 1; i <= 2; i++) { const r = store.begin("old", i, true); r.update({ stage: "failed" }, materials(i)); r.settle(); } await store.flush();
  const confirmation = gate<boolean>(); let count = 0;
  const clearing = store.clear(n => { count = n; return confirmation.promise; }, () => false);
  assert.equal(store.clearing, true); assert.equal((await session.start(session.snapshot().revision)).ok, false);
  while (!count) await new Promise(resolve => setImmediate(resolve)); assert.equal(count, 2); confirmation.resolve(false); assert.equal(await clearing, false);
  assert.equal((await store.list()).total, 2);
  await mkdir(path.join(dir, "secure-config")); await writeFile(path.join(dir, "secure-config", "config"), "sentinel"); await writeFile(path.join(dir, "user-export"), "sentinel");
  assert.equal(await store.clear(async n => n === 2, () => false), true); assert.deepEqual(await readdir(store.directory), []);
  assert.equal(await readFile(path.join(dir, "secure-config", "config"), "utf8"), "sentinel"); assert.equal(await readFile(path.join(dir, "user-export"), "utf8"), "sentinel");
  assert.equal((await new HistoryStore(dir).list()).total, 0);
});
test("durable deletion tombstone is never shown as valid and can be cleaned on restart", async t => {
  const { dir, store } = await fixture(t); const r = store.begin("old", 1, true); r.update({ stage: "failed" }, materials(1)); r.settle(); await store.flush();
  const { rename } = await import("node:fs/promises"); await rename(path.join(store.directory, r.record.id), path.join(store.directory, `.deleted-${r.record.id}`));
  const fresh = new HistoryStore(dir); assert.equal((await fresh.list()).items[0].deleting, true); assert.equal((await fresh.detail(r.record.id)).record, null);
  await fresh.delete(r.record.id); assert.equal((await fresh.list()).total, 0);
});
test("arbitrary paths and reparse record directories cannot escape history deletion", async t => {
  const { dir, store } = await fixture(t); await store.list();
  await assert.rejects(store.delete("../secure-config")); await assert.rejects(store.detail("C:\\Windows"));
  const r = store.begin("junction", 1, true); r.settle();
  const outside = path.join(dir, "keep"); await mkdir(outside); await writeFile(path.join(outside, "sentinel"), "keep");
  await symlink(outside, path.join(store.directory, r.record.id), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(store.delete(r.record.id)); assert.equal(await readFile(path.join(outside, "sentinel"), "utf8"), "keep");
});
test("metadata readers finish before replacement starts, avoiding Windows open-file rename conflicts", async t => {
  const { store } = await fixture(t); const round = store.begin("中文文件占用回归", 1, true);
  round.update({ stage: "failed" }, materials(1)); round.settle(); await store.flush();
  const reader = gate<void>(), entered = gate<void>(); let writes = 0;
  const internals = store as unknown as { read(id: string): Promise<unknown>; atomic(file: string, bytes: Uint8Array | string): Promise<void> };
  const originalRead = internals.read.bind(store), originalAtomic = internals.atomic.bind(store);
  internals.read = async id => { entered.resolve(); await reader.promise; return originalRead(id); };
  internals.atomic = async (...args) => { writes++; await originalAtomic(...args); };
  const detail = store.detail(round.record.id); await entered.promise;
  round.update({ stage: "complete", transcript: "已确认的中文最终转写。", feedback: { mode: "text", message: "# 已完成\n\n中文反馈" } });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(writes, 0);
  reader.resolve(); await detail; assert.equal(await store.flush(), true); assert.ok(writes > 0);
  assert.equal((await store.detail(round.record.id)).record?.stage, "complete");
});
