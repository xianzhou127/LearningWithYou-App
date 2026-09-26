import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { ConfigurationPanel } from "../desktop/configuration-panel";
import type { AnalysisTestRequest, ConfigurationPayload, ConfigurationStatus, DesktopApi, ConnectionTestResult } from "../desktop/shared";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const passed: ConnectionTestResult = { reachable: true, text: "passed", image: "passed", imageObservation: "matched", cancelled: false, error: null };
async function fixture() {
  let status: ConfigurationStatus = { ready: false, analysisReady: false, asrReady: false, hasAnalysisKey: false, hasAsrKey: false, baseUrl: null, model: null, mode: null, asrProvider: null, analysisProfiles: [], asrProfiles: [], selectedAnalysisId: null, selectedAsrId: null, error: null };
  const calls: { action: string; payload?: ConfigurationPayload; request?: AnalysisTestRequest }[] = [];
  const nodes = new Map<string, { value: string; focus(): void }>(); let visibility!: (visible: boolean) => void;
  let failSave = false, probe: Promise<ConnectionTestResult | null> | null = null;
  const api: Pick<DesktopApi, "configuration" | "testAnalysis" | "onSettingsVisibility"> = {
    onSettingsVisibility: f => { visibility = f; return () => {}; },
    configuration: async (action, value) => {
      calls.push({ action, payload: value });
      if (failSave && action.startsWith("add-")) return { ...status, error: "save_failed" };
      if (action === "add-analysis" && value && "model" in value) { const id = randomUUID(); status.analysisProfiles.push({ id, model: value.model, baseUrl: value.baseUrl, mode: value.mode, hasKey: !!value.apiKey }); status.selectedAnalysisId = id; }
      if (action === "add-asr" && value && "provider" in value) { const id = randomUUID(); status.asrProfiles.push({ id, provider: value.provider, hasKey: true }); status.selectedAsrId = id; }
      if (value && "id" in value) {
        if (action === "select-analysis") status.selectedAnalysisId = value.id;
        if (action === "select-asr") status.selectedAsrId = value.id;
        if (action === "delete-analysis") { status.analysisProfiles = status.analysisProfiles.filter(p => p.id !== value.id); status.selectedAnalysisId = null; }
        if (action === "delete-asr") { status.asrProfiles = status.asrProfiles.filter(p => p.id !== value.id); status.selectedAsrId = null; }
      }
      const analysis = status.analysisProfiles.find(p => p.id === status.selectedAnalysisId), asr = status.asrProfiles.find(p => p.id === status.selectedAsrId);
      status = { ...status, ready: !!analysis && !!asr, analysisReady: !!analysis, asrReady: !!asr, hasAnalysisKey: !!analysis?.hasKey, hasAsrKey: !!asr, baseUrl: analysis?.baseUrl ?? null, model: analysis?.model ?? null, mode: analysis?.mode ?? null, asrProvider: asr?.provider ?? null };
      return structuredClone(status);
    },
    testAnalysis: async (action, request) => { calls.push({ action: `test-${action}`, request }); return action === "cancel" ? null : probe ?? passed; },
  };
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(<ConfigurationPanel api={api} />, { createNodeMock: e => {
    if (e.type === "input") { const node = { value: "", focus() {} }; nodes.set((e.props as { id: string }).id, node); return node; }
    if (e.type === "dialog") return { showModal() {}, close() {} }; return null;
  } }); });
  return { tree, calls, nodes, root: () => tree.root, getStatus: () => status, failSave: (value: boolean) => { failSave = value; }, holdProbe: (value: Promise<ConnectionTestResult | null>) => { probe = value; }, visibility: (value: boolean) => visibility(value) };
}

test("analysis list opens an add dialog, probes unsaved fields, saves/selects new entries, switches and deletes only selected", async () => {
  const f = await fixture(), root = f.root;
  assert.equal(root().findAllByType("dialog").length, 0); assert.equal(root().findByProps({ id: "config-analysis-list" }).props.disabled, true);
  await act(async () => root().findByProps({ "aria-label": "添加分析配置" }).props.onClick());
  assert.equal(root().findByProps({ id: "config-model" }).type, "input"); assert.equal(root().findByProps({ id: "config-new-key" }).props.type, "password");
  assert.equal(root().findAllByProps({ id: "config-asr-provider" }).length, 0);
  await act(async () => { root().findByProps({ id: "config-url" }).props.onChange({ target: { value: "http://localhost:11434/v1" } }); root().findByProps({ id: "config-model" }).props.onChange({ target: { value: "owner/vision:1" } }); });
  f.nodes.get("config-new-key")!.value = "synthetic-new-analysis";
  await act(async () => root().findAllByType("button").find(b => b.children.includes("测试此配置"))!.props.onClick());
  const probe = f.calls.find(c => c.action === "test-start")!.request!; assert.equal(probe.kind, "draft");
  if (probe.kind === "draft") { assert.equal(probe.draft.apiKey, "synthetic-new-analysis"); assert.equal(probe.draft.baseUrl, "http://localhost:11434/v1"); }
  assert.equal(f.calls.filter(c => c.action === "add-analysis").length, 0);
  await act(async () => root().findByProps({ id: "config-model" }).props.onChange({ target: { value: "owner/vision:2" } })); assert.doesNotMatch(JSON.stringify(f.tree.toJSON()), /测试图辨认匹配/);
  const keyNode = f.nodes.get("config-new-key")!;
  await act(async () => root().findByType("form").props.onSubmit({ preventDefault() {} }));
  assert.equal(keyNode.value, ""); assert.equal(root().findAllByType("dialog").length, 0);
  const first = f.getStatus().selectedAnalysisId!; assert.equal(root().findByProps({ id: "config-analysis-list" }).props.value, first);
  await act(async () => root().findByProps({ "aria-label": "添加分析配置" }).props.onClick()); assert.equal(f.nodes.get("config-new-key")!.value, "");
  await act(async () => root().findByType("form").props.onSubmit({ preventDefault() {} }));
  const second = f.getStatus().selectedAnalysisId!; assert.notEqual(first, second); assert.equal(f.getStatus().analysisProfiles.length, 2);
  const additions = f.calls.filter(c => c.action === "add-analysis"); assert.equal((additions[1].payload as { apiKey: string }).apiKey, "");
  await act(async () => root().findByProps({ id: "config-analysis-list" }).props.onChange({ target: { value: first } }));
  await act(async () => root().findAllByType("button").find(b => b.children.includes("测试分析连接"))!.props.onClick());
  assert.deepEqual(f.calls.filter(c => c.action === "test-start")[1].request, { kind: "saved", id: first });
  await act(async () => root().findByProps({ "aria-label": "删除选中的分析配置" }).props.onClick());
  assert.equal(f.getStatus().analysisProfiles[0].id, second); assert.equal(root().findByProps({ id: "config-analysis-list" }).props.value, "");
  assert.equal(root().findByProps({ "aria-label": "删除选中的分析配置" }).props.disabled, true);
  await act(async () => f.tree.unmount());
});

test("ASR add dialog has only provider/key, keeps failed draft, clears cancelled keys and saves/deletes independently", async () => {
  const f = await fixture(), root = f.root;
  await act(async () => root().findByProps({ "aria-label": "添加 ASR 配置" }).props.onClick());
  assert.equal(root().findByProps({ id: "config-asr-provider" }).props.value, "bailian"); assert.equal(root().findByProps({ id: "config-new-key" }).props.required, true);
  assert.equal(root().findAllByProps({ id: "config-model" }).length, 0); assert.equal(root().findAllByProps({ id: "config-url" }).length, 0);
  const key = f.nodes.get("config-new-key")!; key.value = "synthetic-asr"; f.failSave(true);
  await act(async () => root().findByType("form").props.onSubmit({ preventDefault() {} }));
  assert.equal(root().findAllByType("dialog").length, 1); assert.equal(key.value, "synthetic-asr"); assert.equal(root().findAllByProps({ role: "alert" }).length, 1);
  await act(async () => root().findByProps({ "aria-label": "关闭添加配置" }).props.onClick()); assert.equal(key.value, ""); assert.equal(f.getStatus().asrProfiles.length, 0);
  f.failSave(false); await act(async () => root().findByProps({ "aria-label": "添加 ASR 配置" }).props.onClick());
  f.nodes.get("config-new-key")!.value = "synthetic-asr-saved"; await act(async () => root().findByType("form").props.onSubmit({ preventDefault() {} }));
  assert.equal(root().findAllByType("dialog").length, 0); assert.equal(f.getStatus().asrProfiles.length, 1); assert.equal(f.getStatus().analysisProfiles.length, 0);
  await act(async () => root().findByProps({ "aria-label": "删除选中的 ASR 配置" }).props.onClick()); assert.equal(f.getStatus().asrProfiles.length, 0);
  await act(async () => f.tree.unmount());
});

test("saved connection tests show immediate progress, cancellation, failure and retry beside the analysis button", async () => {
  const f = await fixture(), root = f.root;
  await act(async () => root().findByProps({ "aria-label": "添加分析配置" }).props.onClick());
  await act(async () => root().findByType("form").props.onSubmit({ preventDefault() {} }));
  const section = () => root().findByProps({ "aria-label": "分析模型配置" });
  const button = (label: string) => section().findAllByType("button").find(b => b.children.includes(label))!;
  const feedbackText = () => section().findByProps({ role: "status" }).findAllByType("p").map(p => p.children.join("")).join(" ");
  let resolve!: (result: ConnectionTestResult) => void;
  f.holdProbe(new Promise(r => { resolve = r; }));
  await act(async () => { button("测试分析连接").props.onClick(); button("测试分析连接").props.onClick(); });
  assert.equal(f.calls.filter(c => c.action === "test-start").length, 1);
  assert.equal(button("正在测试…").props.disabled, true);
  assert.match(feedbackText(), /正在测试文字与图片请求/);
  assert.equal(root().findByProps({ "aria-label": "ASR 配置" }).findAllByProps({ role: "status" }).length, 0);
  await act(async () => button("取消测试").props.onClick());
  assert.ok(f.calls.some(c => c.action === "test-cancel"));
  await act(async () => resolve({ ...passed, cancelled: true }));
  assert.match(JSON.stringify(f.tree.toJSON()), /已取消测试/);
  f.holdProbe(Promise.resolve({ ...passed, text: "failed", image: "pending", error: "鉴权失败。" }));
  await act(async () => button("测试分析连接").props.onClick());
  assert.match(feedbackText(), /鉴权失败/);
  assert.equal(button("测试分析连接").props.disabled, false);
  f.holdProbe(Promise.resolve(passed));
  await act(async () => button("测试分析连接").props.onClick());
  assert.match(feedbackText(), /测试图辨认匹配/);
  assert.doesNotMatch(JSON.stringify(f.tree.toJSON()), /鉴权失败/);
  await act(async () => f.tree.unmount());
});

test("connection test IPC rejection and missing result remain visible beside the button and allow retry", async () => {
  const f = await fixture(), root = f.root;
  await act(async () => root().findByProps({ "aria-label": "添加分析配置" }).props.onClick());
  await act(async () => root().findByType("form").props.onSubmit({ preventDefault() {} }));
  const section = () => root().findByProps({ "aria-label": "分析模型配置" });
  const start = () => section().findAllByType("button").find(b => b.children.includes("测试分析连接"))!;
  let reject!: (error: Error) => void;
  f.holdProbe(new Promise((_resolve, r) => { reject = r; }));
  await act(async () => start().props.onClick());
  await act(async () => reject(new Error("synthetic IPC failure")));
  assert.match(section().findByProps({ role: "alert" }).children.join(""), /连接测试未完成/);
  assert.equal(start().props.disabled, false);
  f.holdProbe(Promise.resolve(null));
  await act(async () => start().props.onClick());
  assert.match(section().findByProps({ role: "alert" }).children.join(""), /未返回结果/);
  assert.equal(start().props.disabled, false);
  await act(async () => f.tree.unmount());
});

test("hiding settings discards dialog secrets and cancels probes; late results cannot reopen or overwrite new UI", async () => {
  const f = await fixture(), root = f.root;
  let resolve!: (value: ConnectionTestResult) => void; f.holdProbe(new Promise(r => { resolve = r; }));
  await act(async () => root().findByProps({ "aria-label": "添加分析配置" }).props.onClick());
  const key = f.nodes.get("config-new-key")!; key.value = "synthetic-unsaved";
  await act(async () => root().findAllByType("button").find(b => b.children.includes("测试此配置"))!.props.onClick());
  await act(async () => f.visibility(false)); assert.equal(key.value, ""); assert.equal(root().findAllByType("dialog").length, 0);
  assert.ok(f.calls.some(c => c.action === "test-cancel"));
  await act(async () => resolve(passed)); assert.doesNotMatch(JSON.stringify(f.tree.toJSON()), /测试图辨认匹配/);
  await act(async () => root().findByProps({ "aria-label": "添加分析配置" }).props.onClick()); assert.equal(f.nodes.get("config-new-key")!.value, "");
  await act(async () => root().findByType("dialog").props.onCancel({ preventDefault() {} })); assert.equal(root().findAllByType("dialog").length, 0);
  assert.equal(f.calls.filter(c => c.action === "add-analysis").length, 0); await act(async () => f.tree.unmount());
});
