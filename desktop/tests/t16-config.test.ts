import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { ConfigurationStore, parseConfiguration, type Encryption } from "../config";
import { parseBaseUrl, readConfiguration, readAsrKey } from "../../trusted/analysis/configuration";
import { isAnalysisModel } from "../../shared/analysis-models";
import { readAsrConfiguration } from "../../trusted/asr-configuration";
import { MAX_CONFIGURATION_PROFILES, type AnalysisConfigurationDraft } from "../shared";

const legacy = { DASHSCOPE_API_KEY: "synthetic-shared-key", QWEN_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1", QWEN_MODEL: "qwen3.8-max", ANALYSIS_OUTPUT_MODE: "text" };
const legacyText = Object.entries(legacy).map(([k, v]) => `${k}=${v}`).join("\n");
const draft: AnalysisConfigurationDraft = { baseUrl: "http://localhost:11434/v1", model: "owner/vision-v2.1:Q4_K_M", apiKey: "", mode: "text" };
const asrDraft = { provider: "bailian", apiKey: "synthetic-asr-key" };
function encryption(): Encryption {
  const key = randomBytes(32);
  return { isEncryptionAvailable: () => true,
    encryptString(value) { const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv); const bytes = Buffer.concat([cipher.update(value), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), bytes]); },
    decryptString(value) { const decipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12)); decipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString(); },
  };
}
async function fixture() { const dir = await mkdtemp(path.join(tmpdir(), "t16-config-")), secret = encryption(); return { dir, secret, store: new ConfigurationStore(dir, secret), file: path.join(dir, "configuration.v3.encrypted") }; }

test("Base URL preserves port/proxy/version and handles local IPv4/IPv6/LAN and trailing slashes", () => {
  for (const url of ["https://cloud.example:8443/gateway/api/v3", "http://localhost:11434/v1", "http://127.0.0.1:1234/v1", "http://[::1]:8000/v1", "http://192.168.1.10:8080/proxy/v1", "http://model-pc.local:9000/prefix", "http://10.0.0.2:8000", "http://[fd00::2]:8000/v1"]) {
    for (const suffix of ["", "/", "///"]) assert.deepEqual(parseBaseUrl(url + suffix), { baseUrl: url, endpoint: url + "/chat/completions" });
  }
  for (const url of ["file:///test", "ftp://localhost", "", "https://u:p@host/v1", "https://host/v1?key=secret", "https://host/v1#part", "http://host/a b", "http://host\\evil"]) assert.deepEqual(parseBaseUrl(url), { error: "invalid_base_url" });
  for (const suffix of ["chat/completions", "chat/completions/", "chat%2fcompletions", "responses", "completions"]) assert.deepEqual(parseBaseUrl("https://host/prefix/v1/" + suffix), { error: "full_endpoint" });
  assert.deepEqual(parseBaseUrl("http://localhost/" + "文".repeat(300)), { error: "invalid_base_url" });
});
test("custom model identifiers have bounds/control checks and generic config never falls back", () => {
  for (const model of ["gpt-4.1", "llama3.2-vision:11b", "org/any-model.v1:Q4", "未知模型", "x".repeat(256)]) assert.ok(isAnalysisModel(model));
  for (const model of ["", "x\n", "a\u0000b", "a\u0085b", "x".repeat(257), "\uD800"]) assert.equal(isAnalysisModel(model), false);
  const generic = { ANALYSIS_BASE_URL: draft.baseUrl, ANALYSIS_MODEL: draft.model, ANALYSIS_API_KEY: "" };
  assert.equal(readConfiguration(generic)?.apiKey, "");
  assert.equal(readConfiguration({ ...legacy, ...generic })?.apiKey, "");
  assert.equal(readConfiguration({ ...legacy, ANALYSIS_BASE_URL: "" }), null);
  assert.equal(readAsrKey({ ...legacy, ASR_API_KEY: "" }), "");
});
test("legacy and generic env imports normalize, reject duplicates/oversized/malformed fields", () => {
  const imported = parseConfiguration(legacyText)!;
  assert.equal(imported.ANALYSIS_API_KEY, legacy.DASHSCOPE_API_KEY); assert.equal(imported.ASR_API_KEY, legacy.DASHSCOPE_API_KEY);
  assert.equal(imported.DASHSCOPE_API_KEY, undefined);
  assert.equal(parseConfiguration(legacyText + "\nUNKNOWN_FIELD=ignored")?.UNKNOWN_FIELD, undefined);
  assert.ok(parseConfiguration(legacyText.replace("qwen3.8-max", '"org/new-model:1" # comment')));
  for (const invalid of ["", legacyText + "\nDASHSCOPE_API_KEY=second", legacyText.replace("https:", "http:"), legacyText.replace("dashscope.aliyuncs.com", "other.example"), legacyText.replace("ANALYSIS_OUTPUT_MODE=text", "ANALYSIS_OUTPUT_MODE=xml"), legacyText.replace(legacy.DASHSCOPE_API_KEY, ""), "x".repeat(65537)]) assert.equal(parseConfiguration(invalid), null);
  assert.equal(parseConfiguration(`ANALYSIS_BASE_URL=${draft.baseUrl}\nANALYSIS_MODEL=${draft.model}\nANALYSIS_API_KEY=`)?.ANALYSIS_API_KEY, "");
});

test("v1 migrates to two selected encrypted profiles, preserving old files/history and redacting every key", async () => {
  const f = await fixture(), old = f.secret.encryptString(JSON.stringify(legacy));
  const oldFile = path.join(f.dir, "configuration.v1.encrypted"); await writeFile(oldFile, old);
  await writeFile(path.join(f.dir, "history-sentinel"), "unchanged"); await f.store.load();
  const status = f.store.status(); assert.equal(status.ready, true); assert.equal(status.analysisProfiles.length, 1); assert.equal(status.asrProfiles.length, 1);
  assert.equal(status.asrProvider, "bailian"); assert.equal(f.store.snapshot().ASR_API_KEY, legacy.DASHSCOPE_API_KEY);
  assert.equal(f.store.snapshot().ANALYSIS_API_KEY, legacy.DASHSCOPE_API_KEY); assert.deepEqual(await readFile(oldFile), old);
  const bytes = await readFile(f.file); assert.ok(!bytes.includes(Buffer.from(legacy.DASHSCOPE_API_KEY)));
  assert.equal(JSON.parse(f.secret.decryptString(bytes)).schema, 3); assert.ok(!JSON.stringify(status).includes("synthetic"));
  const restart = new ConfigurationStore(f.dir, f.secret); await restart.load(); assert.deepEqual(restart.status(), status);
  assert.equal(await readFile(path.join(f.dir, "history-sentinel"), "utf8"), "unchanged");
});

test("multiple analysis and ASR entries select independently, bind their own key and preserve in-flight snapshots", async () => {
  const f = await fixture();
  await f.store.mutate("add-analysis", { ...draft, apiKey: "synthetic-analysis-one" }); const first = f.store.status().selectedAnalysisId!;
  await f.store.mutate("add-asr", asrDraft); const firstAsr = f.store.status().selectedAsrId!;
  const round = f.store.snapshot();
  await f.store.mutate("add-analysis", { ...draft, baseUrl: "http://localhost:1234/proxy/v1", model: "new/model:2", mode: "json" }); const second = f.store.status().selectedAnalysisId!;
  assert.equal(f.store.snapshot().ANALYSIS_API_KEY, ""); assert.equal(f.store.snapshot().ASR_API_KEY, asrDraft.apiKey);
  await f.store.mutate("add-asr", { ...asrDraft, apiKey: "synthetic-asr-two" }); const secondAsr = f.store.status().selectedAsrId!;
  assert.equal(f.store.snapshot().ANALYSIS_MODEL, "new/model:2");
  await f.store.mutate("select-analysis", { id: first }); assert.equal(f.store.snapshot().ANALYSIS_API_KEY, "synthetic-analysis-one"); assert.equal(f.store.snapshot().ASR_API_KEY, "synthetic-asr-two");
  await f.store.mutate("select-asr", { id: firstAsr }); assert.deepEqual(f.store.snapshot(), round);
  await f.store.mutate("select-analysis", { id: second }); await f.store.mutate("select-asr", { id: secondAsr });
  const restart = new ConfigurationStore(f.dir, f.secret); await restart.load(); assert.deepEqual(restart.snapshot(), f.store.snapshot());
  assert.equal(round.ANALYSIS_API_KEY, "synthetic-analysis-one"); assert.equal(round.ASR_API_KEY, asrDraft.apiKey);
  const publicState = restart.status(); assert.equal(publicState.analysisProfiles.length, 2); assert.equal(publicState.asrProfiles.length, 2);
  assert.ok(!JSON.stringify(publicState).includes("synthetic")); publicState.analysisProfiles[0].model = "tampered";
  assert.equal(restart.status().analysisProfiles[0].model, draft.model);
});

test("ASR and analysis can be added separately; ASR requires its own key while local analysis allows empty", async () => {
  const f = await fixture(); await f.store.mutate("add-asr", asrDraft);
  assert.equal(f.store.status().analysisReady, false); assert.equal(f.store.status().asrReady, true); assert.equal(f.store.status().ready, false);
  const before = await readFile(f.file);
  assert.equal((await f.store.mutate("add-asr", { ...asrDraft, apiKey: "" })).error, "missing_asr_key"); assert.deepEqual(await readFile(f.file), before);
  await f.store.mutate("add-analysis", draft); assert.equal(f.store.status().ready, true); assert.equal(f.store.status().hasAnalysisKey, false);
});

test("delete selected clears selection without switching providers; delete only its entry; stale ids cannot change files", async () => {
  const f = await fixture(); await f.store.mutate("add-analysis", draft); const first = f.store.status().selectedAnalysisId!;
  await f.store.mutate("add-analysis", { ...draft, model: "second" }); const second = f.store.status().selectedAnalysisId!;
  await f.store.mutate("add-asr", asrDraft); const asr = f.store.status().selectedAsrId!;
  await f.store.mutate("delete-analysis", { id: first }); assert.equal(f.store.status().selectedAnalysisId, second);
  await f.store.mutate("add-analysis", { ...draft, model: "third" }); const third = f.store.status().selectedAnalysisId!;
  await f.store.mutate("delete-analysis", { id: third }); assert.equal(f.store.status().selectedAnalysisId, null); assert.equal(f.store.status().analysisProfiles.length, 1);
  assert.equal(f.store.status().selectedAsrId, asr); assert.equal(f.store.status().ready, false);
  const before = await readFile(f.file);
  for (const action of ["select-analysis", "delete-analysis"] as const) assert.equal((await f.store.mutate(action, { id: third })).error, "profile_not_found");
  assert.deepEqual(await readFile(f.file), before); assert.deepEqual(f.store.resolveAnalysisTest({ kind: "saved", id: third }), { error: "profile_not_found" });
  const restart = new ConfigurationStore(f.dir, f.secret); await restart.load(); assert.equal(restart.status().selectedAnalysisId, null);
  await restart.mutate("select-analysis", { id: second }); assert.equal(restart.status().ready, true);
  await restart.mutate("delete-asr", { id: asr }); assert.equal(restart.status().selectedAsrId, null); assert.equal(restart.status().asrProfiles.length, 0); assert.equal(restart.status().analysisReady, true);
});

function v2(provider = true) { return { schema: 2, analysis: { protocol: "openai-chat-completions", baseUrl: draft.baseUrl, model: draft.model, apiKey: "synthetic-v2-analysis", mode: "json" }, asr: { ...(provider ? { provider: "bailian" } : {}), protocol: "bailian-streaming-v1", apiKey: asrDraft.apiKey } }; }
test("both v2 variants migrate selected entries to v3 without altering source or reviving an older v1", async () => {
  for (const provider of [true, false]) {
    const f = await fixture(), old = f.secret.encryptString(JSON.stringify(v2(provider)));
    const file = path.join(f.dir, "configuration.v2.encrypted"); await writeFile(file, old);
    await writeFile(path.join(f.dir, "configuration.v1.encrypted"), f.secret.encryptString(JSON.stringify(legacy)));
    await f.store.load(); assert.equal(f.store.status().ready, true); assert.equal(f.store.status().mode, "json");
    assert.equal(f.store.snapshot().ANALYSIS_API_KEY, "synthetic-v2-analysis"); assert.equal(f.store.snapshot().ASR_API_KEY, asrDraft.apiKey);
    assert.deepEqual(await readFile(file), old); assert.equal(f.store.status().asrProvider, "bailian");
    const saved = await readFile(f.file); await f.store.mutate("add-analysis", draft);
    const backups = await Promise.all((await readdir(path.join(f.dir, "backups"))).map(name => readFile(path.join(f.dir, "backups", name)))); assert.ok(backups.some(b => b.equals(saved)));
  }
});

test("v2 tombstone, v3 clear and deletion of last entries never resurrect preserved older configuration", async () => {
  const f = await fixture(); await writeFile(path.join(f.dir, "configuration.v1.encrypted"), f.secret.encryptString(JSON.stringify(legacy)));
  await writeFile(path.join(f.dir, "configuration.v2.encrypted"), f.secret.encryptString(JSON.stringify({ schema: 2, analysis: null, asr: { protocol: "bailian-streaming-v1", apiKey: "" } })));
  await f.store.load(); assert.deepEqual(f.store.snapshot(), {}); assert.equal(f.store.status().analysisProfiles.length, 0);
  await f.store.mutate("add-analysis", draft); await f.store.mutate("delete-analysis", { id: f.store.status().selectedAnalysisId });
  const restart = new ConfigurationStore(f.dir, f.secret); await restart.load(); assert.deepEqual(restart.snapshot(), {});
  await restart.mutate("add-asr", asrDraft); await restart.clear(); await f.store.load(); assert.deepEqual(f.store.snapshot(), {});
});

test("imports append/deduplicate entries and analysis-only imports preserve all ASR choices", async () => {
  const f = await fixture(); await f.store.mutate("add-analysis", draft); await f.store.mutate("add-asr", asrDraft);
  const asr = f.store.status().selectedAsrId; const file = path.join(f.dir, "import.env");
  await writeFile(file, "ANALYSIS_BASE_URL=https://other.example/proxy/v1\nANALYSIS_MODEL=another/model\nANALYSIS_API_KEY=");
  assert.equal((await f.store.importFile(file)).error, null); assert.equal(f.store.status().analysisProfiles.length, 2); assert.equal(f.store.status().selectedAsrId, asr);
  assert.equal(f.store.snapshot().ASR_API_KEY, asrDraft.apiKey); await f.store.importFile(file); assert.equal(f.store.status().analysisProfiles.length, 2);
  await writeFile(file, legacyText); await f.store.importFile(file); assert.equal(f.store.status().analysisProfiles.length, 3); assert.equal(f.store.status().asrProfiles.length, 2);
  const before = await readFile(f.file); await writeFile(file, "bad"); assert.equal((await f.store.importFile(file)).error, "invalid_configuration"); assert.deepEqual(await readFile(f.file), before);
  await writeFile(file, Buffer.alloc(65537)); assert.equal((await f.store.importFile(file)).error, "read_failed");
});

test("failed save/delete/encryption/migration preserves encrypted sources and active state", async () => {
  const f = await fixture(); await f.store.mutate("add-analysis", draft); const before = await readFile(f.file), id = f.store.status().selectedAnalysisId;
  f.secret.encryptString = () => { throw new Error("private"); };
  assert.equal((await f.store.mutate("delete-analysis", { id })).error, "save_failed"); assert.equal(f.store.status().selectedAnalysisId, id); assert.deepEqual(await readFile(f.file), before);
  assert.equal((await f.store.mutate("add-analysis", { ...draft, model: "new" })).error, "save_failed"); assert.equal(f.store.status().analysisProfiles.length, 1);
  f.secret.isEncryptionAvailable = () => false; assert.equal((await f.store.clear()).error, "encryption_unavailable");
  const wrong = new ConfigurationStore(f.dir, encryption()); await wrong.load(); assert.equal(wrong.status().error, "decryption_failed");
  const migrate = await fixture(), old = migrate.secret.encryptString(JSON.stringify(v2())); const oldFile = path.join(migrate.dir, "configuration.v2.encrypted"); await writeFile(oldFile, old);
  migrate.secret.encryptString = () => { throw new Error("private"); }; await migrate.store.load(); assert.equal(migrate.store.status().error, "save_failed"); assert.deepEqual(await readFile(oldFile), old);
  const broken = await fixture(); await mkdir(broken.file); await broken.store.load(); assert.equal(broken.store.status().error, "decryption_failed");
});

test("untrusted additions and forged selections cannot overwrite profiles or inject credentials/addresses", async () => {
  const f = await fixture(); await f.store.mutate("add-analysis", draft); const before = await readFile(f.file);
  for (const bad of [null, [], {}, { ...draft, id: "replace-existing" }, { ...draft, apiKey: 42 }, { ...draft, apiKey: "a\nb" }, { ...draft, apiKey: "x".repeat(4097) }, { ...draft, baseUrl: "file:///tmp" }, { ...draft, model: "" }, { ...draft, mode: "xml" }]) {
    assert.ok((await f.store.mutate("add-analysis", bad)).error); assert.deepEqual(await readFile(f.file), before);
  }
  assert.ok((await f.store.mutate("add-analysis", Object.assign(Object.create(draft), { one: "a", two: "b", three: "c", four: "d" }))).error);
  for (const provider of ["unknown", "", "__proto__", "constructor"]) {
    assert.equal((await f.store.mutate("add-asr", { ...asrDraft, provider })).error, "unsupported_asr_provider");
    assert.equal(parseConfiguration(`${legacyText}\nASR_PROVIDER=${provider}`), null); assert.equal(readAsrConfiguration({ ...legacy, ASR_PROVIDER: provider }), null);
  }
  assert.ok((await f.store.mutate("select-analysis", { id: f.store.status().selectedAnalysisId, apiKey: "forged" })).error); assert.deepEqual(await readFile(f.file), before);
});

test("corrupt v3 or v2 never fall back: unknown provider/protocol, duplicate ids and dangling selections", async () => {
  const f = await fixture(); await f.store.mutate("add-analysis", draft); await f.store.mutate("add-asr", asrDraft);
  const saved = JSON.parse(f.secret.decryptString(await readFile(f.file)));
  await writeFile(path.join(f.dir, "configuration.v2.encrypted"), f.secret.encryptString(JSON.stringify(v2())));
  for (const bad of [{ schema: 99 }, { ...saved, asr: [{ ...saved.asr[0], provider: "future" }] }, { ...saved, asr: [{ ...saved.asr[0], protocol: "other" }] }, { ...saved, analysis: [saved.analysis[0], saved.analysis[0]] }, { ...saved, selectedAnalysisId: saved.asr[0].id }]) {
    const bytes = f.secret.encryptString(JSON.stringify(bad)); await writeFile(f.file, bytes); await f.store.load();
    assert.equal(f.store.status().error, "decryption_failed"); assert.deepEqual(f.store.snapshot(), {}); assert.deepEqual(await readFile(f.file), bytes);
  }
  const old = await fixture(); await writeFile(path.join(old.dir, "configuration.v2.encrypted"), old.secret.encryptString(JSON.stringify({ ...v2(), asr: { ...v2().asr, provider: "unknown" } })));
  await writeFile(path.join(old.dir, "configuration.v1.encrypted"), old.secret.encryptString(JSON.stringify(legacy))); await old.store.load(); assert.equal(old.store.status().error, "decryption_failed"); assert.deepEqual(old.store.snapshot(), {});
});

test("saved tests resolve only their bound key; draft probes never inherit saved analysis or ASR keys and never persist", async () => {
  const f = await fixture(); await f.store.mutate("add-analysis", { ...draft, apiKey: "synthetic-saved-analysis" }); await f.store.mutate("add-asr", asrDraft);
  const before = await readFile(f.file), snapshot = f.store.snapshot(), id = f.store.status().selectedAnalysisId;
  const saved = f.store.resolveAnalysisTest({ kind: "saved", id }); assert.ok("config" in saved); assert.equal(saved.config.ANALYSIS_API_KEY, "synthetic-saved-analysis"); assert.equal(saved.config.ASR_API_KEY, undefined);
  const probe = f.store.resolveAnalysisTest({ kind: "draft", draft }); assert.ok("config" in probe); assert.equal(probe.config.ANALYSIS_API_KEY, ""); assert.equal(probe.config.ASR_API_KEY, undefined);
  for (const value of [null, { kind: "saved", id, baseUrl: "https://exfil.example" }, { kind: "draft", draft: { ...draft, keyAction: "keep" } }]) assert.ok("error" in f.store.resolveAnalysisTest(value));
  assert.deepEqual(await readFile(f.file), before); assert.deepEqual(f.store.snapshot(), snapshot);
});

test("bounded profile counts reject excess without replacing selections or writing partial imports", async () => {
  const f = await fixture();
  for (let i = 0; i < MAX_CONFIGURATION_PROFILES; i++) { await f.store.mutate("add-analysis", { ...draft, model: `model-${i}` }); await f.store.mutate("add-asr", { ...asrDraft, apiKey: `synthetic-${i}` }); }
  const before = await readFile(f.file), selected = f.store.status().selectedAnalysisId;
  assert.equal((await f.store.mutate("add-analysis", draft)).error, "profile_limit"); assert.equal((await f.store.mutate("add-asr", asrDraft)).error, "profile_limit");
  const file = path.join(f.dir, "import.env"); await writeFile(file, legacyText); assert.equal((await f.store.importFile(file)).error, "profile_limit");
  assert.equal(f.store.status().selectedAnalysisId, selected); assert.deepEqual(await readFile(f.file), before);
});
