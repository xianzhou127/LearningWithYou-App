import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { PcmSender } from "../pcm-sender";
import { MAX_PCM_PACKET_BYTES, type PcmPacket } from "../shared";
import { validPcmPacket, parseAction } from "../security";

// Configuration regression cases moved to t16-config.test.ts for the v2 schema.
test("PCM sender preserves order, waits for every acknowledgement and delivers partial tail", async () => {
  const packets: PcmPacket[] = []; let ack!: (v: boolean) => void;
  const sender = new PcmSender(3, 7, packet => { packets.push(packet); return packets.length === 1 ? new Promise(resolve => { ack = resolve; }) : Promise.resolve(true); }, () => assert.fail("unexpected failure"));
  sender.push(new Int16Array(1600).fill(1).buffer); sender.push(new Int16Array(1600).fill(2).buffer); sender.push(new Int16Array([3, 4]).buffer);
  let finished = false; const tail = sender.drain().then(sequence => { finished = true; return sequence; });
  assert.equal(packets.length, 1); assert.equal(finished, false); ack(true);
  assert.equal(await tail, 2); assert.deepEqual(packets.map(p => [p.sessionId, p.roundId, p.sequence]), [[3, 7, 0], [3, 7, 1], [3, 7, 2]]);
  assert.deepEqual(Array.from(new Int16Array(packets[2].bytes)), [3, 4]);
});
test("PCM queue overflow, cancellation, acknowledgement rejection and timeout fail explicitly", async () => {
  let failures = 0;
  const sender = new PcmSender(1, 1, async () => new Promise(() => {}), () => failures++, 4000, 10);
  sender.push(new ArrayBuffer(3200)); sender.push(new ArrayBuffer(1000)); await assert.rejects(sender.drain()); assert.equal(failures, 1);
  const cancelled = new PcmSender(1, 1, async () => new Promise(() => {}), () => failures++, undefined, 10);
  cancelled.push(new ArrayBuffer(3200)); const drain = cancelled.drain(); cancelled.cancel(); await assert.rejects(drain); assert.equal(failures, 1);
  const rejected = new PcmSender(1, 1, async () => false, () => failures++); rejected.push(new ArrayBuffer(100)); await assert.rejects(rejected.drain());
  const timeout = new PcmSender(1, 1, async () => new Promise(() => {}), () => failures++, undefined, 5); timeout.push(new ArrayBuffer(100)); await assert.rejects(timeout.drain()); assert.equal(failures, 3);
});
test("PCM IPC rejects malformed, odd, oversized or injected address payloads", () => {
  const packet = { sessionId: 1, roundId: 2, sequence: 0, bytes: new ArrayBuffer(16) };
  assert.equal(validPcmPacket(packet), true);
  for (const candidate of [{ ...packet, sequence: -1 }, { ...packet, bytes: "audio" }, { ...packet, bytes: new ArrayBuffer(3) }, { ...packet, bytes: new ArrayBuffer(MAX_PCM_PACKET_BYTES + 2) }, { ...packet, url: "https://example.com" }]) assert.equal(validPcmPacket(candidate), false);
  assert.throws(() => parseAction({ type: "retry", revision: 1, endpoint: "https://example.com" }));
});
test("worklet flush sends partial resampling group before terminal acknowledgement and stops output", () => {
  const messages: { type: string; buffer?: ArrayBuffer }[] = [];
  let Processor!: new (options: object) => { process(inputs: Float32Array[][]): boolean; port: { onmessage: (event: { data: object }) => void } };
  const realm = { sampleRate: 48000, AudioWorkletProcessor: class { port = { postMessage: (message: { type: string }) => messages.push(message), onmessage: null }; }, registerProcessor: (_name: string, cls: typeof Processor) => { Processor = cls; } };
  vm.runInNewContext(readFileSync("public/pcm-worklet.js", "utf8"), realm);
  const processor = new Processor({ processorOptions: { targetSampleRate: 16000 } });
  processor.process([[new Float32Array([0.5, 0.5, 0.5, 0.75])]]); processor.port.onmessage({ data: { type: "flush" } });
  assert.deepEqual(messages.map(m => m.type), ["audio", "audio", "flushed"]);
  assert.equal(new Int16Array(messages[1].buffer!)[0], 24575);
  assert.equal(processor.process([[new Float32Array([1, 1, 1])]]), false);
  processor.port.onmessage({ data: { type: "flush" } }); assert.equal(messages.length, 3);
});
