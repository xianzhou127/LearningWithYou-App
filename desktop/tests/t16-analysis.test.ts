import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import sharp from "sharp";
import { analyze, buildModelRequest, MAX_MODEL_RESPONSE_BYTES } from "../../trusted/analysis/service";
import { parseAnalysisResponse, type AnalysisOutputIssue } from "../../shared/analysis-contract";
import { TEXT_SYSTEM_PROMPT } from "../../trusted/analysis/text-prompt";
import { testAnalysisConnection } from "../connection-test";
import { createCloudServices } from "../services";

const env = { ANALYSIS_BASE_URL: "http://127.0.0.1:11434/proxy/v1", ANALYSIS_MODEL: "org/local-vision:Q4", ANALYSIS_API_KEY: "", ASR_API_KEY: "synthetic-asr-only-secret", ANALYSIS_OUTPUT_MODE: "text" };
const input = { start_screenshot: "data:image/png;base64,START", end_screenshot: "data:image/png;base64,END", transcript: "测试最终转写。" };
const envelope = (content = "有效反馈正文", extra = {}, finish_reason = "stop") => Response.json({ choices: [{ finish_reason, message: { role: "assistant", content, ...extra } }] });

test("generic request has only portable fields, unchanged prompt, two images and final transcript; no auth means no header", async () => {
  for (const model of [env.ANALYSIS_MODEL, "qwen3.8-max", "gpt-custom", "no-capability-inference"]) {
    let calls = 0;
    const result = await analyze(input, new AbortController().signal, { env: { ...env, ANALYSIS_MODEL: model }, fetcher: async (url, options) => {
      calls++; assert.equal(url, env.ANALYSIS_BASE_URL + "/chat/completions");
      assert.equal(new Headers(options?.headers).has("Authorization"), false); assert.equal(options?.redirect, "manual");
      const body = JSON.parse(options!.body as string); assert.deepEqual(Object.keys(body).sort(), ["messages", "model", "stream"]);
      assert.equal(body.model, model); assert.equal(body.messages[0].content, TEXT_SYSTEM_PROMPT);
      assert.deepEqual(body.messages[1].content.filter((x: { type: string }) => x.type === "image_url").map((x: { image_url: { url: string } }) => x.image_url.url), [input.start_screenshot, input.end_screenshot]);
      assert.ok(body.messages[1].content.at(-1).text.endsWith(input.transcript)); return envelope();
    } });
    assert.equal(calls, 1); assert.ok(result.ok); assert.equal(result.details?.model, model); assert.equal(result.details?.thinking_enabled, null); assert.equal(result.details?.thinking_budget, null);
    assert.ok(parseAnalysisResponse(result).ok);
  }
  assert.equal(Object.hasOwn(buildModelRequest(input, "arbitrary", "text"), "response_format"), false);
});
test("optional metadata cannot block either valid body mode and keys echoed by upstream never leave trusted boundary", async () => {
  const services = createCloudServices(() => env, { fetcher: async () => envelope(env.ASR_API_KEY) });
  assert.equal((await services.analyze(input, env, new AbortController().signal, () => {})).ok, false);
  for (const mode of ["text", "json"]) {
    const content = mode === "text" ? "反馈" : JSON.stringify({ topic: null, understanding: null, evidence: "", verdict: "affirm", message: "反馈。" });
    const result = await analyze(input, new AbortController().signal, { env: { ...env, ANALYSIS_OUTPUT_MODE: mode }, fetcher: async () => envelope(content, { reasoning_content: { invalid: true } }) });
    assert.ok(result.ok); assert.equal(result.details?.reasoning_content, null); assert.ok(parseAnalysisResponse(result).ok);
  }
  const secret = "synthetic-analysis-secret";
  const leaked = await analyze(input, new AbortController().signal, { env: { ...env, ANALYSIS_API_KEY: secret }, fetcher: async () => envelope(secret) });
  assert.equal(leaked.ok, false); assert.ok(!JSON.stringify(leaked).includes(secret));
  const escaped = 'synthetic-escaped"key\\token';
  const escapedResult = await analyze(input, new AbortController().signal, { env: { ...env, ANALYSIS_API_KEY: escaped }, fetcher: async () => envelope(`echo ${escaped}`) });
  assert.equal(escapedResult.ok, false); assert.ok(!JSON.stringify(escapedResult).includes("synthetic-escaped"));
});
test("safe error mapping distinguishes access/model/protocol/capability/rate/timeout/server and unknown reasons", async () => {
  for (const [status, body, expected] of [
    [401, { error: { message: "private key" } }, "model_access_denied"],
    [403, {}, "model_access_denied"], [404, {}, "model_protocol_error"],
    [404, { error: { code: "model_not_found", message: "private request" } }, "model_not_found"],
    [400, { error: "model 'abc' not found" }, "model_not_found"],
    [400, { error: { message: "model does not support images" } }, "model_capability_unsupported"],
    [422, { error: { message: "response_format json_schema is unsupported" } }, "model_capability_unsupported"],
    [400, { error: { message: "unexplained private error" } }, "model_request_rejected"],
    [405, {}, "model_protocol_error"], [429, {}, "model_rate_limited"], [504, {}, "model_timeout"], [503, {}, "model_unavailable"],
  ] as const) {
    let calls = 0;
    const result = await analyze(input, new AbortController().signal, { env, fetcher: async () => { calls++; return Response.json(body, { status }); } });
    assert.equal(calls, 1); assert.ok(!result.ok); assert.equal(result.error.code, expected); assert.ok(!JSON.stringify(result).includes("private"));
  }
});
test("rejects empty, HTML, reasoning-only, refusal, truncation and oversized responses", async () => {
  for (const response of [envelope(""), envelope("<html><body>Bad Gateway</body></html>"), envelope("<think>not final</think>"),
    envelope("", { reasoning_content: "reasoning only" }), envelope("feedback", { refusal: "refused" }), envelope("partial", {}, "length"),
    envelope("x".repeat(MAX_MODEL_RESPONSE_BYTES)), new Response("<html>proxy error</html>")]) {
    const issues: AnalysisOutputIssue[] = [];
    const result = await analyze(input, new AbortController().signal, { env, fetcher: async () => response, onValidationFailure: issue => issues.push(issue) });
    assert.equal(result.ok, false); assert.equal(issues.length, 1);
  }
});
test("bounded timeout, abort and ignored late responses cannot become feedback", async () => {
  for (const cancel of [true, false]) {
    const controller = new AbortController();
    const result = await analyze(input, controller.signal, { env, timeoutMs: cancel ? 1000 : 10,
      fetcher: async () => { if (cancel) controller.abort(); await new Promise(r => setTimeout(r, 30)); return envelope(); } });
    assert.ok(!result.ok); assert.equal(result.error.code, cancel ? "model_unavailable" : "model_timeout");
  }
  const signal = AbortSignal.abort();
  assert.equal((await analyze(input, signal, { env, fetcher: async () => assert.fail("already aborted") })).ok, false);
});
test("real loopback HTTP transport (mock server) preserves proxy path, omits auth and never follows cross-origin redirects", async t => {
  let targetHits = 0; const target = createServer((_q, r) => { targetHits++; r.end("unexpected"); });
  await new Promise<void>(r => target.listen(0, "127.0.0.1", r));
  const targetPort = (target.address() as { port: number }).port;
  let redirect = false; let requests = 0;
  const server = createServer((q, r) => {
    requests++; assert.equal(q.url, "/gateway/v1/chat/completions");
    if (redirect) { r.writeHead(307, { Location: `http://127.0.0.1:${targetPort}/leak` }); r.end(); return; }
    assert.equal(q.headers.authorization, undefined);
    r.setHeader("Content-Type", "application/json"); r.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "loopback synthetic feedback" } }] }));
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  t.after(async () => { await Promise.all([server, target].map(s => new Promise<void>(r => { s.close(() => r()); s.closeAllConnections(); }))); });
  const config = { ...env, ANALYSIS_BASE_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}/gateway/v1` };
  assert.ok((await analyze(input, new AbortController().signal, { env: config })).ok);
  redirect = true;
  const result = await analyze(input, new AbortController().signal, { env: { ...config, ANALYSIS_API_KEY: "synthetic-bound-secret" } });
  assert.ok(!result.ok); assert.equal(result.error.code, "model_protocol_error"); assert.equal(targetHits, 0); assert.equal(requests, 2);
});
test("connection test uses synthetic text plus two PNGs only, no models discovery, no save; returns fixed observations", async () => {
  let calls = 0;
  const result = await testAnalysisConnection(env, new AbortController().signal, { fetcher: async (url, options) => {
    calls++; assert.ok(String(url).endsWith("/chat/completions"));
    const body = JSON.parse(options!.body as string); assert.equal(body.response_format, undefined);
    if (calls === 1) { assert.equal(typeof body.messages[0].content, "string"); return envelope("TEST_OK"); }
    const images = body.messages[0].content.filter((v: { type: string }) => v.type === "image_url"); assert.equal(images.length, 2);
    const colors = await Promise.all(images.map(async (v: { image_url: { url: string } }) => {
      assert.ok(v.image_url.url.startsWith("data:image/png;base64,"));
      const { data, info } = await sharp(Buffer.from(v.image_url.url.split(",")[1], "base64")).raw().toBuffer({ resolveWithObject: true });
      assert.equal(info.width, 128); assert.equal(info.height, 128);
      return data[0] === 255 ? data[1] === 255 ? "YELLOW" : "RED" : data[1] === 255 ? "GREEN" : "BLUE";
    })); return envelope(colors.join(" "));
  } });
  assert.deepEqual(result, { reachable: true, text: "passed", image: "passed", imageObservation: "matched", cancelled: false, error: null }); assert.equal(calls, 2);
});
test("connection test distinguishes reachability from auth, text success from image failure, cancellation and unconfirmed vision", async () => {
  const auth = await testAnalysisConnection(env, new AbortController().signal, { fetcher: async () => Response.json({}, { status: 401 }) });
  assert.equal(auth.reachable, true); assert.equal(auth.text, "failed"); assert.equal(auth.image, "pending");
  let calls = 0;
  const image = await testAnalysisConnection(env, new AbortController().signal, { fetcher: async () => ++calls === 1 ? envelope() : Response.json({ error: { message: "images unsupported" } }, { status: 400 }) });
  assert.equal(image.text, "passed"); assert.equal(image.image, "failed"); assert.match(image.error!, /图片/);
  const unknown = await testAnalysisConnection(env, new AbortController().signal, { fetcher: async () => envelope("I ignored the images") });
  assert.equal(unknown.image, "passed"); assert.equal(unknown.imageObservation, "unconfirmed");
  const controller = new AbortController();
  const cancelled = await testAnalysisConnection(env, controller.signal, { fetcher: async () => { controller.abort(); return envelope(); } });
  assert.equal(cancelled.cancelled, true);
  const offline = await testAnalysisConnection(env, new AbortController().signal, { fetcher: async () => { throw new TypeError("private transport failure"); } });
  assert.equal(offline.reachable, false); assert.match(offline.error!, /无法连接/);
});
