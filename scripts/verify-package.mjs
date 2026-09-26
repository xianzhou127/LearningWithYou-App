// External production-package smoke test. Synthetic credentials, local mock API,
// isolated userData and disabled material capture; no real learning media/API.
import { createRequire } from 'node:module';
import { readFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { watchMain, finishMain } from './main-errors.mjs';
const require = createRequire(import.meta.url);
const { _electron: electron } = require('playwright');
const asar = createRequire(require.resolve('@electron/packager'))('@electron/asar');
const directory = JSON.parse(await readFile('release/latest.json', 'utf8')).directories[0];
const out = path.resolve('artifacts/smoke', 'package-' + new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(out, { recursive: true });
const profile = await mkdtemp(path.join(os.tmpdir(), 'LearningWithYou-App-check-'));
await mkdir(path.join(profile, 'appearance-v1'));
await writeFile(path.join(profile, 'appearance-v1/material-v1.json'), JSON.stringify({ application: 'LearningWithYou', schema: 1, kind: 'material', settings: { highlightStrength: 3 }, startupEnabled: false }));
const manifest = JSON.parse(await readFile(path.join(directory, 'package-manifest.json'), 'utf8'));
const report = { directory, profile, resourceCount: manifest.packagedFiles.length, checks: [], errors: [], completed: false,
  scope: 'Real packaged app, Windows safeStorage, isolated profile, local mock HTTP; no actual model/ASR/media' };
for (const f of manifest.packagedFiles) assert.equal(createHash('sha256').update(asar.extractFile(path.join(directory, 'resources/app.asar'), path.normalize(f.file))).digest('hex'), f.sha256, f.file);
assert.ok(!manifest.packagedFiles.some(f => /experiments|simulated|tests|\.env/.test(f.file)));
const launchEnv = { ...process.env }; delete launchEnv.ELECTRON_RUN_AS_NODE;
let app, hold = false, rejectRequest = false, requests = 0, closeCount = 0;
const apiErrors = [];
const server = createServer(async (q, r) => {
  try {
    requests++; assert.equal(q.url, '/proxy/v1/chat/completions'); assert.equal(q.headers.authorization, undefined);
    if (hold) { r.on('close', () => closeCount++); return; }
    if (rejectRequest) { r.writeHead(401, { 'Content-Type': 'application/json' }); r.end(JSON.stringify({ error: { code: 'invalid_api_key' } })); return; }
    const chunks = []; for await (const chunk of q) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert.deepEqual(Object.keys(body).sort(), ['messages', 'model', 'stream']);
    let content = 'TEST_OK';
    if (Array.isArray(body.messages[0].content)) {
      const colors = await Promise.all(body.messages[0].content.filter(p => p.type === 'image_url').map(async p => {
        const pixels = await sharp(Buffer.from(p.image_url.url.split(',')[1], 'base64')).raw().toBuffer();
        return pixels[0] === 255 ? pixels[1] === 255 ? 'YELLOW' : 'RED' : pixels[1] === 255 ? 'GREEN' : 'BLUE';
      })); assert.equal(colors.length, 2); content = colors.join(' ');
    }
    r.setHeader('Content-Type', 'application/json'); r.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }] }));
  } catch { apiErrors.push('mock request assertion failed'); r.statusCode = 500; r.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const baseUrl = `http://127.0.0.1:${server.address().port}/proxy/v1`;
async function launch() {
  const a = await electron.launch({ executablePath: path.join(directory, 'LearningWithYou-App.exe'), cwd: directory, args: [`--user-data-dir=${profile}`], env: launchEnv });
  await watchMain(a, out); a.on('window', p => p.on('pageerror', () => report.errors.push('renderer error'))); return a;
}
async function page(role) {
  for (let i = 0; i < 100; i++) { const p = app.windows().find(p => p.url().endsWith(`?role=${role}`)); if (p) { p.setDefaultTimeout(15000); return p; } await new Promise(r => setTimeout(r, 100)); }
  throw Error('Missing role: ' + role);
}
try {
  app = await launch();
  const firstOrb = await page('orb'); await firstOrb.locator('.learning-toolbar').waitFor();
  // Seed previous v2 plus a retained v1. The real app must migrate only v2.
  await app.evaluate(async ({ safeStorage, app }) => {
    const fs = process.getBuiltinModule('fs/promises'), p = process.getBuiltinModule('path');
    if (!safeStorage.isEncryptionAvailable()) throw Error('Windows encryption unavailable');
    const dir = p.join(app.getPath('userData'), 'secure-config'); await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(p.join(dir, 'configuration.v1.encrypted'), safeStorage.encryptString(JSON.stringify({ DASHSCOPE_API_KEY: 'synthetic-v1-unused', QWEN_BASE_URL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', QWEN_MODEL: 'qwen3.8-max', ANALYSIS_OUTPUT_MODE: 'text' })));
    await fs.writeFile(p.join(dir, 'configuration.v2.encrypted'), safeStorage.encryptString(JSON.stringify({ schema: 2,
      analysis: { protocol: 'openai-chat-completions', apiKey: 'synthetic-migration-secret', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen3.8-max', mode: 'text' },
      asr: { provider: 'bailian', protocol: 'bailian-streaming-v1', apiKey: 'synthetic-migration-asr' } })));
  });
  const legacy = await readFile(path.join(profile, 'secure-config/configuration.v2.encrypted'));
  await app.close(); app = await launch();
  const orb = await page('orb'); await orb.locator('.learning-toolbar').waitFor();
  assert.equal((await orb.evaluate(() => window.desktop.state())).simulated, false);
  assert.equal((await orb.evaluate(() => window.appearance.config())).enabled, false);
  const security = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ role: w.webContents.getURL().split('?role=')[1], protected: w.isContentProtected(), prefs: w.webContents.getLastWebPreferences() })));
  assert.ok(security.every(w => w.prefs.contextIsolation && w.prefs.sandbox && !w.prefs.nodeIntegration && w.prefs.webSecurity));
  assert.equal(security.find(w => w.role === 'orb').protected, true);
  report.checks.push('cloud adapter, unchanged isolation/sandbox/webSecurity, capsule capture exclusion, no material capture in fixture');
  await orb.evaluate(() => window.desktop.view('settings'));
  const settings = await page('settings'); await settings.getByRole('button', { name: '添加分析配置', exact: true }).waitFor();
  const status = () => settings.evaluate(() => window.desktop.configuration('status'));
  const migrated = await status(); assert.equal(migrated.ready, true); assert.equal(migrated.model, 'qwen3.8-max');
  assert.equal(migrated.analysisProfiles.length, 1); assert.equal(migrated.asrProfiles.length, 1); assert.ok(!JSON.stringify(migrated).includes('synthetic'));
  assert.deepEqual(await readFile(path.join(profile, 'secure-config/configuration.v2.encrypted')), legacy);
  assert.ok((await readFile(path.join(profile, 'secure-config/configuration.v3.encrypted'))).length > 0);
  const oldAnalysis = migrated.selectedAnalysisId, oldAsr = migrated.selectedAsrId;
  report.checks.push('actual Windows encrypted v2-to-v3 migration creates two selected profiles, preserves v2 and ignores retained v1');
  await settings.screenshot({ path: path.join(out, 'settings-profiles.png') });

  await settings.getByRole('button', { name: '添加分析配置', exact: true }).click();
  const modal = settings.getByRole('dialog', { name: '添加分析配置', exact: true }); await modal.waitFor();
  assert.equal(await modal.locator('#config-new-key').inputValue(), ''); assert.equal(await modal.locator('#config-new-key').getAttribute('type'), 'password');
  assert.equal(await settings.evaluate(() => document.activeElement?.id), 'config-new-key');
  for (let i = 0; i < 12; i++) { await settings.keyboard.press('Tab'); assert.equal(await settings.evaluate(() => !!document.activeElement?.closest('dialog')), true); }
  await modal.locator('#config-url').fill(baseUrl + '/chat/completions'); await modal.locator('#config-model').fill('org/local-vision:Q4');
  await modal.getByRole('button', { name: '保存', exact: true }).click(); await modal.getByText(/请填写 API Base URL/).waitFor();
  assert.equal((await status()).analysisProfiles.length, 1); assert.equal(requests, 0);
  await modal.locator('#config-url').fill(baseUrl);
  await modal.screenshot({ path: path.join(out, 'settings-add-analysis.png') });
  await modal.getByRole('button', { name: '测试此配置', exact: true }).click(); await modal.getByText(/测试图辨认匹配/).waitFor(); assert.equal(requests, 2);
  assert.equal((await status()).analysisProfiles.length, 1);
  await modal.getByRole('button', { name: '保存', exact: true }).click(); await modal.waitFor({ state: 'hidden' });
  const saved = await status(); const localAnalysis = saved.selectedAnalysisId;
  assert.equal(saved.hasAnalysisKey, false); assert.equal(saved.selectedAsrId, oldAsr); assert.equal(saved.analysisProfiles.length, 2); assert.equal(requests, 2);
  assert.equal(await settings.locator('#config-analysis-list').inputValue(), localAnalysis);
  report.checks.push('analysis add modal validates before saving, sends unauthenticated draft probe without inheriting old key, then saves/selects without network');

  // Escape, Cancel and hiding discard temporary inputs without adding anything.
  await settings.getByRole('button', { name: '添加分析配置', exact: true }).click();
  await modal.locator('#config-new-key').fill('synthetic-cancelled-key'); await settings.keyboard.press('Escape'); await modal.waitFor({ state: 'hidden' });
  await settings.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '添加分析配置');
  await settings.getByRole('button', { name: '添加分析配置', exact: true }).click(); assert.equal(await modal.locator('#config-new-key').inputValue(), '');
  await modal.locator('#config-new-key').fill('synthetic-hidden-key');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('?role=settings')).hide());
  await orb.evaluate(() => window.desktop.view('settings')); await settings.getByRole('button', { name: '添加分析配置', exact: true }).click();
  assert.equal(await modal.locator('#config-new-key').inputValue(), ''); await modal.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal((await status()).analysisProfiles.length, 2);
  report.checks.push('native modal focus/restoration, Escape/Cancel/hide discard temporary keys and never add entries');

  await settings.getByRole('button', { name: '添加 ASR 配置', exact: true }).click();
  const asrModal = settings.getByRole('dialog', { name: '添加 ASR 配置', exact: true }); await asrModal.waitFor();
  assert.deepEqual(await asrModal.locator('#config-asr-provider option').evaluateAll(nodes => nodes.map(n => n.value)), ['bailian']);
  assert.equal(await asrModal.locator('#config-url').count(), 0); assert.equal(await asrModal.locator('#config-model').count(), 0);
  await asrModal.getByText('查看 ASR 预设信息', { exact: true }).click(); await asrModal.screenshot({ path: path.join(out, 'settings-add-asr.png') });
  await asrModal.locator('#config-new-key').fill('synthetic-second-asr'); await asrModal.getByRole('button', { name: '保存', exact: true }).click(); await asrModal.waitFor({ state: 'hidden' });
  const addedAsr = await status(); assert.equal(addedAsr.asrProfiles.length, 2); assert.equal(addedAsr.selectedAnalysisId, localAnalysis); assert.notEqual(addedAsr.selectedAsrId, oldAsr); assert.equal(requests, 2);
  await settings.locator('#config-asr-list').selectOption(oldAsr); await settings.getByText(/已保存选择/).waitFor();
  assert.equal((await status()).selectedAnalysisId, localAnalysis);
  await settings.locator('#config-asr-list').selectOption(addedAsr.selectedAsrId); await settings.getByText(/已保存选择/).waitFor();
  await settings.getByRole('button', { name: '删除选中的 ASR 配置', exact: true }).click(); await settings.getByText(/已删除所选配置/).waitFor();
  const deletedAsr = await status(); assert.equal(deletedAsr.selectedAsrId, null); assert.equal(deletedAsr.asrProfiles.length, 1); assert.equal(deletedAsr.asrReady, false);
  await settings.locator('#config-asr-list').selectOption(oldAsr); await settings.getByText(/已保存选择/).waitFor();

  await settings.getByRole('button', { name: '添加分析配置', exact: true }).click();
  await modal.locator('#config-url').fill(baseUrl); await modal.locator('#config-model').fill('org/temporary:1');
  await modal.getByRole('button', { name: '保存', exact: true }).click(); await modal.waitFor({ state: 'hidden' });
  const temporaryId = (await status()).selectedAnalysisId;
  await settings.locator('#config-analysis-list').selectOption(oldAnalysis); await settings.getByText(/已保存选择/).waitFor();
  assert.equal((await status()).selectedAsrId, oldAsr);
  await settings.locator('#config-analysis-list').selectOption(temporaryId); await settings.getByText(/已保存选择/).waitFor();
  await settings.getByRole('button', { name: '删除选中的分析配置', exact: true }).click(); await settings.getByText(/已删除所选配置/).waitFor();
  const deleted = await status(); assert.equal(deleted.selectedAnalysisId, null); assert.equal(deleted.analysisProfiles.length, 2); assert.equal(deleted.selectedAsrId, oldAsr);
  await settings.locator('#config-analysis-list').selectOption(localAnalysis); await settings.getByText(/已保存选择/).waitFor();
  report.checks.push('two independent lists select immediately; deletes remove only selected entry and leave that service unselected; no implicit fallback or network');
  assert.equal(requests, 2);
  const analysisSection = settings.getByRole('region', { name: '分析模型配置', exact: true });
  // Do not use locator.click on feedback: it would scroll an offscreen result
  // into view and conceal the missing response reported by the user.
  const inViewport = locator => locator.evaluate(node => {
    const rect = node.getBoundingClientRect();
    let top = 0, bottom = innerHeight;
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(parent).overflowY)) {
        const bounds = parent.getBoundingClientRect(); top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom);
      }
    }
    return rect.top >= top && rect.bottom <= bottom;
  });
  hold = true;
  await settings.getByRole('button', { name: '测试分析连接', exact: true }).click();
  await settings.getByText(/正在测试文字与图片请求/).waitFor();
  await settings.screenshot({ path: path.join(out, 'settings-test-pending.png') });
  assert.equal(await analysisSection.getByRole('button', { name: '取消测试', exact: true }).count(), 1, 'Test progress/cancel must appear next to the analysis button, above ASR');
  const testingButton = analysisSection.getByRole('button', { name: '正在测试…', exact: true });
  assert.equal(await testingButton.isDisabled(), true);
  assert.equal(await inViewport(analysisSection.getByRole('button', { name: '取消测试', exact: true })), true);
  for (let i = 0; requests < 3 && i < 200; i++) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(requests, 3, 'The saved-profile button must actually reach the mock service');
  await analysisSection.getByRole('button', { name: '取消测试', exact: true }).click(); await analysisSection.getByText(/已取消测试/).waitFor();
  hold = false; rejectRequest = true;
  await settings.getByRole('button', { name: '测试分析连接', exact: true }).click();
  await analysisSection.getByText(/文字请求：失败/).waitFor();
  assert.equal(await inViewport(analysisSection.getByText(/文字请求：失败/)), true);
  assert.equal(await analysisSection.getByRole('button', { name: '测试分析连接', exact: true }).isEnabled(), true);
  await settings.screenshot({ path: path.join(out, 'settings-test-failed.png') });
  rejectRequest = false;
  await settings.getByRole('button', { name: '测试分析连接', exact: true }).click(); await analysisSection.getByText(/测试图辨认匹配/).waitFor(); assert.equal(requests, 6);
  assert.equal(await inViewport(analysisSection.getByText(/测试图辨认匹配/)), true);
  await settings.screenshot({ path: path.join(out, 'settings-test-passed.png') });
  report.checks.push('saved test button responds immediately; delayed/cancelled, HTTP failure and success feedback stay beside the button in the viewport; retry works');

  const beforeForgery = await readFile(path.join(profile, 'secure-config/configuration.v3.encrypted'));
  const rejected = await settings.evaluate(async id => {
    const mutation = await window.desktop.configuration('delete-analysis', { id });
    const test = await window.desktop.testAnalysis('start', { kind: 'saved', id });
    return { error: mutation.error, testError: test.error };
  }, temporaryId);
  assert.equal(rejected.error, 'profile_not_found'); assert.ok(rejected.testError); assert.equal(requests, 6);
  assert.deepEqual(await readFile(path.join(profile, 'secure-config/configuration.v3.encrypted')), beforeForgery);
  const denied = await orb.evaluate(async () => { try { await window.desktop.configuration('add-asr', { provider: 'bailian', apiKey: 'synthetic-forged' }); return false; } catch { return true; } }); assert.equal(denied, true);
  hold = true;
  await settings.getByRole('button', { name: '测试分析连接', exact: true }).click();
  await settings.getByRole('button', { name: '取消测试', exact: true }).click(); await settings.getByText(/已取消测试/).waitFor();
  await settings.getByRole('button', { name: '测试分析连接', exact: true }).click(); await settings.getByRole('button', { name: '取消测试', exact: true }).waitFor();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('?role=settings')).hide());
  hold = false; await orb.evaluate(() => window.desktop.view('settings'));
  await settings.getByRole('button', { name: '测试分析连接', exact: true }).click(); await settings.getByText(/测试图辨认匹配/).waitFor();
  await settings.screenshot({ path: path.join(out, 'settings-saved-profiles.png') });
  report.checks.push('saved-profile probe resolves key in main; stale ids and cross-role IPC rejected; cancel/hide abort and reopen can retest');
  await app.close(); app = await launch(); const restartedOrb = await page('orb'); await restartedOrb.locator('.learning-toolbar').waitFor();
  await restartedOrb.evaluate(() => window.desktop.view('settings')); const restartedSettings = await page('settings');
  await restartedSettings.getByRole('button', { name: '添加分析配置', exact: true }).waitFor();
  const recovered = await restartedSettings.evaluate(() => window.desktop.configuration('status'));
  assert.equal(recovered.selectedAnalysisId, localAnalysis); assert.equal(recovered.selectedAsrId, oldAsr); assert.equal(recovered.model, 'org/local-vision:Q4'); assert.equal(recovered.hasAnalysisKey, false);
  assert.equal(recovered.analysisProfiles.length, 2); assert.equal(recovered.asrProfiles.length, 1); assert.ok(!JSON.stringify(recovered).includes('synthetic'));
  assert.deepEqual(await readFile(path.join(profile, 'secure-config/configuration.v2.encrypted')), legacy);
  const snap = await restartedOrb.evaluate(() => window.desktop.state()); assert.equal(snap.recording, false); assert.equal(snap.analysis, null);
  assert.equal(await readFile(path.join(profile, 'history-v1/index.json')).catch(() => null), null);
  report.checks.push('restart restores both lists/selections and deleted entries stay deleted; keys redacted; no settings-triggered recording/history');
  assert.deepEqual(apiErrors, []); assert.deepEqual(report.errors, []); report.completed = true;
} catch (error) { report.failure = String(error.stack || error); process.exitCode = 1; }
finally {
  if (app) await app.close().catch(() => {});
  await new Promise(r => { server.close(r); server.closeAllConnections(); });
  await finishMain(report, out); report.mockRequests = requests; report.cancelledConnections = closeCount;
  await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ out, completed: report.completed, checks: report.checks, errors: report.errors, failure: report.failure }, null, 2));
}
