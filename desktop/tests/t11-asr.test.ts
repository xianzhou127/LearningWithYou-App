import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { CloudAsrConnection, createCloudServices } from "../services";
import { applyTranscriptUpdate, emptyTranscript, getFinalTranscript } from "../../shared/transcript";
import { buildModelRequest } from "../../trusted/analysis/service";

const config = { DASHSCOPE_API_KEY: "test-credential-never-expose", QWEN_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1", QWEN_MODEL: "qwen3.8-max", ANALYSIS_OUTPUT_MODE: "text" };
test("shared ASR protocol buffers connecting PCM, preserves order and waits for late final sentence and task-finished", async t => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" }); await once(server, "listening");
  t.after(() => { server.clients.forEach(c => c.terminate()); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const packets: number[] = []; let finishCount = 0; let taskId = "";
  server.on("connection", (socket, request) => { assert.equal(request.headers.authorization, "Bearer synthetic-independent-asr"); socket.on("message", (data, binary) => {
    if (binary) { packets.push(Buffer.from(data as Buffer).readInt16LE(0)); return; }
    const value = JSON.parse(data.toString()); taskId = value.header.task_id;
    const send = (event: string, text?: string, final?: boolean) => socket.send(JSON.stringify({ header: { task_id: taskId, event }, payload: { output: { sentence: { sentence_id: 1, text, sentence_end: final } } } }));
    if (value.header.action === "run-task") {
      assert.equal(value.payload.model, "qwen-audio-3.0-asr-flash-streaming");
      setTimeout(() => { send("task-started"); send("result-generated", "最", false); send("result-generated", "最后", false); }, 15);
    }
    if (value.header.action === "finish-task") {
      finishCount++;
      setTimeout(() => { send("result-generated", "最后一句完整。", true); send("result-generated", "最后一句完整。", true); send("task-finished"); }, 20);
    }
  }); });
  let transcript = structuredClone(emptyTranscript);
  const roundConfig = { ANALYSIS_BASE_URL: "http://localhost:11434/v1", ANALYSIS_MODEL: "org/local:1", ANALYSIS_API_KEY: "synthetic-analysis-never-asr", ASR_PROVIDER: "bailian", ASR_API_KEY: "synthetic-independent-asr" };
  const connection = new CloudAsrConnection(roundConfig, update => { transcript = applyTranscriptUpdate(transcript, update); }, error => assert.fail(error.code), { upstreamUrl: `ws://127.0.0.1:${address.port}` });
  // The connection captures its provider/key; later settings cannot alter it.
  roundConfig.ASR_PROVIDER = "unsupported"; roundConfig.ASR_API_KEY = "synthetic-next-round";
  const ready = connection.start(); connection.send(new Int16Array([1, 1]).buffer); connection.send(new Int16Array([2, 2]).buffer);
  await ready; connection.send(new Int16Array([3]).buffer); await Promise.all([connection.finish(), connection.finish()]);
  assert.deepEqual(packets, [1, 2, 3]); assert.equal(finishCount, 1); assert.equal(getFinalTranscript(transcript), "最后一句完整。"); assert.equal(transcript.finalSentences.length, 1); assert.equal(transcript.interimSentence, null);
});

test("unsupported ASR provider fails before any connection and never falls back to Bailian", async t => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" }); await once(server, "listening");
  t.after(() => { server.clients.forEach(c => c.terminate()); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  let connections = 0; server.on("connection", () => connections++);
  const errors: string[] = [];
  const connection = new CloudAsrConnection({ ...config, ASR_PROVIDER: "unknown" }, () => assert.fail("unexpected transcript"), error => errors.push(error.message), { upstreamUrl: `ws://127.0.0.1:${address.port}` });
  await assert.rejects(connection.start(), /ASR 厂家尚未支持/);
  connection.cancel(); assert.equal(connections, 0); assert.equal(errors.length, 1);
  assert.ok(!errors[0].includes(config.DASHSCOPE_API_KEY));
});
test("ASR timeout, finish timeout, empty audio and queue limit are explicit failures with no reconnect", async t => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" }); await once(server, "listening");
  t.after(() => { server.clients.forEach(c => c.terminate()); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  let connections = 0; const errors: string[] = [];
  server.on("connection", socket => { const n = ++connections; socket.on("message", (data, binary) => {
    if (binary) return; const value = JSON.parse(data.toString());
    if (n !== 1 && value.header.action === "run-task") socket.send(JSON.stringify({ header: { event: "task-started", task_id: value.header.task_id } }));
  }); });
  const options = { upstreamUrl: `ws://127.0.0.1:${address.port}`, taskStartTimeoutMs: 100, taskFinishTimeoutMs: 20 };
  const first = new CloudAsrConnection(config, () => {}, error => errors.push(error.code), options); await assert.rejects(first.start());
  const second = new CloudAsrConnection(config, () => {}, error => errors.push(error.code), options); await second.start(); second.send(new ArrayBuffer(4)); await assert.rejects(second.finish());
  const third = new CloudAsrConnection(config, () => {}, error => errors.push(error.code), options); await third.start(); await assert.rejects(third.finish());
  const fourth = new CloudAsrConnection(config, () => {}, error => errors.push(error.code), options); const pending = fourth.start();
  assert.throws(() => { for (let i = 0; i < 34; i++) fourth.send(new ArrayBuffer(256 * 1024)); }); await assert.rejects(pending);
  assert.deepEqual(errors, ["connection-timeout", "connection-timeout", "empty-audio", "connection-timeout"]); assert.ok(connections <= 4);
});
test("desktop B and A use the shared request builder and response rules; invalid diagnostics cannot veto B", async () => {
  const input = { start_screenshot: "data:image/jpeg;base64,AAAA", end_screenshot: "data:image/jpeg;base64,BBBB", transcript: "测试解释" };
  const bodies: object[] = [];
  const service = createCloudServices(() => config, { fetcher: async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "- 原正文\n\n<html>按文字展示", reasoning_content: { unexpected: true } } }], usage: { completion_tokens_details: { reasoning_tokens: -1 } } });
  } });
  const result = await service.analyze(input, config, new AbortController().signal, () => {});
  assert.equal(result.ok, true); if (result.ok) { assert.equal(result.mode, "text"); assert.equal(result.result.message, "- 原正文\n\n<html>按文字展示"); }
  assert.deepEqual(bodies[0], buildModelRequest(input, config.QWEN_MODEL, "text", "bailian"));
  const json = { topic: "电路", understanding: "相同", verdict: "affirm", evidence: "材料", message: "理解正确。" };
  const a = createCloudServices(() => config, { fetcher: async () => Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(json) } }] }) });
  const aResult = await a.analyze(input, { ...config, ANALYSIS_OUTPUT_MODE: "json" }, new AbortController().signal, () => {});
  assert.equal(aResult.ok, true); if (aResult.ok) { assert.equal(aResult.mode, "json"); assert.deepEqual(aResult.result, json); }
  const request = buildModelRequest(input, "qwen3.8-max", "text", "bailian"); assert.equal(request.enable_thinking, false); assert.equal(request.temperature, 0.6); assert.equal(request.max_completion_tokens, 16384); assert.equal("response_format" in request, false);
});
test("even a faulty upstream cannot echo a credential into desktop state or diagnostics", async () => {
  const service = createCloudServices(() => config, { fetcher: async () => Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: config.DASHSCOPE_API_KEY } }] }) });
  const response = await service.analyze({ start_screenshot: "", end_screenshot: "", transcript: "" }, config, new AbortController().signal, () => {});
  assert.equal(response.ok, false); assert.ok(!JSON.stringify(response).includes(config.DASHSCOPE_API_KEY));
});
