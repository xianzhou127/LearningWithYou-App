// Actual EXE and Win32 state; isolated profile and generated feedback only.
import { createRequire } from 'node:module';
import { readFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { watchMain, finishMain } from './main-errors.mjs';
const require = createRequire(import.meta.url);
const { _electron: electron } = require('playwright');
const directory = JSON.parse(await readFile('release/latest.json', 'utf8')).directories[0];
const out = path.resolve('artifacts/smoke', 'windows-' + new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(out, { recursive: true });
const profile = await mkdtemp(path.join(os.tmpdir(), 'LearningWithYou-App-windows-'));
await mkdir(path.join(profile, 'appearance-v1'));
await writeFile(path.join(profile, 'appearance-v1/material-v1.json'), JSON.stringify({ application: 'LearningWithYou', schema: 1, kind: 'material', settings: { highlightStrength: 3 }, startupEnabled: false }));
const report = { directory, checks: [], native: [], errors: [], completed: false,
  scope: 'Production EXE, native window state/order and generated feedback; isolated profile, no microphone, desktop capture or API requests.' };
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const roles = ['picker', 'history', 'panel', 'settings'];
const labels = { picker: '选择资料', history: '历史回顾', panel: '本轮详情', settings: '设置' };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let app;
async function page(role) {
  for (let i = 0; i < 100; i++) {
    const p = app.windows().find(p => p.url().endsWith(`?role=${role}`));
    if (p) { p.setDefaultTimeout(10000); return p; }
    await pause(50);
  }
  throw new Error('Missing page: ' + role);
}
async function nativeState(role) {
  return app.evaluate(({ BrowserWindow }, role) => {
    const w = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith(`?role=${role}`));
    return { visible: w.isVisible(), focused: w.isFocused(), minimized: w.isMinimized(), maximized: w.isMaximized(),
      bounds: w.getBounds(), normalBounds: w.getNormalBounds(), topmost: w.isAlwaysOnTop(), maximizable: w.isMaximizable(),
      handle: w.getNativeWindowHandle().readBigUInt64LE().toString(), muted: w.webContents.isAudioMuted() };
  }, role);
}
async function waitNative(role, predicate) {
  for (let i = 0; i < 150; i++) { const state = await nativeState(role); if (predicate(state)) return state; await pause(40); }
  throw new Error('Native state did not settle for ' + role);
}
async function nativeOrder(expected) {
  const handles = await Promise.all([...roles, 'feedback'].map(async role => [role, (await nativeState(role)).handle]));
  const args = ['-NoProfile', '-Command', `& '${path.resolve('scripts/window-order.ps1').replaceAll("'", "''")}' -WindowHandles @(${handles.map(([, h]) => `'${h}'`).join(',')})`];
  const result = JSON.parse(execFileSync('powershell.exe', args, { encoding: 'utf8', windowsHide: true }));
  const byHandle = Object.fromEntries(handles.map(([role, handle]) => [handle, role]));
  const state = { expected, foreground: byHandle[result.foreground] ?? 'other', order: result.order.map(h => byHandle[h]) };
  report.native.push(state); assert.equal(state.foreground, expected); assert.equal(state.order[0], expected);
}
try {
  app = await electron.launch({ executablePath: path.join(directory, 'LearningWithYou-App.exe'), cwd: directory, args: [`--user-data-dir=${profile}`], env });
  await watchMain(app, out); app.on('window', p => p.on('pageerror', () => report.errors.push('renderer-error')));
  const orb = await page('orb'); await orb.locator('.learning-toolbar').waitFor();
  assert.equal((await orb.evaluate(() => window.appearance.config())).enabled, false);
  // Read-only synthetic source list prevents fetching real desktop thumbnails.
  await app.evaluate(({ app, ipcMain }) => {
    const r = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json');
    globalThis.windowFixture = r('./main.cjs').learning;
    windowFixture.publish({ simulated: true, phase: 'ready', feedback: null });
    ipcMain.removeHandler('t10:sources'); ipcMain.handle('t10:sources', () => []);
  });
  const open = async role => {
    if ((await orb.evaluate(() => window.desktop.presentation())).menuOpen) await orb.evaluate(() => window.desktop.view('collapse'));
    await orb.getByRole('button', { name: '更多', exact: true }).click();
    await orb.getByRole('main', { name: '更多学习操作', exact: true }).getByRole('button', { name: labels[role], exact: true }).click();
    await waitNative(role, s => s.visible && s.focused && !s.minimized);
    return page(role);
  };
  for (const role of roles) {
    const p = await open(role), state = await nativeState(role);
    assert.equal(state.topmost, false, 'Reading pages must share normal Z-order: ' + role);
    assert.equal(state.maximizable, true);
    await p.getByRole('button', { name: '最小化', exact: true }).waitFor();
    await p.getByRole('button', { name: '最大化', exact: true }).click();
    await waitNative(role, s => s.maximized);
    await p.getByRole('button', { name: '还原窗口', exact: true }).waitFor();
    await p.screenshot({ path: path.join(out, `${role}-maximized.png`) });
    await p.getByRole('button', { name: '还原窗口', exact: true }).click();
    await waitNative(role, s => !s.maximized);
    assert.deepEqual((await nativeState(role)).bounds, state.bounds);
    // A native OS action must refresh the label as well as an in-app click.
    await app.evaluate(({ BrowserWindow }, role) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith(`?role=${role}`)).maximize(), role);
    await p.getByRole('button', { name: '还原窗口', exact: true }).waitFor();
    await p.getByRole('button', { name: '最小化', exact: true }).click();
    await waitNative(role, s => s.minimized);
    if (role === 'history' || role === 'panel') assert.equal((await nativeState(role)).muted, true);
    await open(role); assert.equal((await nativeState(role)).maximized, true);
    await p.getByRole('button', { name: '还原窗口', exact: true }).click();
    await waitNative(role, s => !s.maximized);
    await p.screenshot({ path: path.join(out, `${role}-restored.png`) });
    await nativeOrder(role);
  }
  // Already-visible destinations must rise above all the other reading pages.
  for (const role of ['history', 'settings', 'panel', 'picker']) { await open(role); await nativeOrder(role); }
  report.checks.push('four real menu entries minimize, maximize/restore, preserve normal bounds and restore maximized state; native actions update labels; opened pages are Win32 foreground/top among reading pages');
  assert.equal(await orb.evaluate(async () => { try { await window.desktop.view('minimize'); return false; } catch { return true; } }), true);
  assert.equal(await orb.evaluate(async () => { try { await window.desktop.view('toggle-maximize'); return false; } catch { return true; } }), true);
  const feedbackText = '## 本轮反馈\n\n这是合成的窗口验收内容，用于检查阅读材质、滚动和页面切换。\n\n' + '反馈正文使用与设置和历史回顾相同的不透明背景。\n\n'.repeat(18);
  await app.evaluate((_, text) => windowFixture.publish({ phase: 'feedback', feedback: text, analysis: { ok: true, mode: 'text', result: { message: text }, details: null } }), feedbackText);
  await orb.evaluate(() => window.desktop.view('feedback'));
  const feedback = await page('feedback'); await feedback.locator('.feedback-body').waitFor();
  await waitNative('feedback', s => s.visible && s.focused);
  await nativeOrder('feedback');
  const styles = await feedback.evaluate(() => {
    const css = selector => getComputedStyle(document.querySelector(selector));
    return { body: css('.feedback-body').backgroundColor, header: css('.reading-header').backgroundColor,
      footer: css('.reading-footer').backgroundColor, radius: css('.learning-feedback').borderRadius,
      material: document.documentElement.dataset.material, frame: document.documentElement.dataset.nativeFrame };
  });
  const settings = await page('settings');
  const reading = await settings.evaluate(() => ({ body: getComputedStyle(document.querySelector('.desktop-surface')).backgroundColor, header: getComputedStyle(document.querySelector('.heading')).backgroundColor }));
  assert.equal(styles.body, reading.body); assert.equal(styles.header, reading.header); assert.equal(styles.footer, reading.header);
  assert.equal(styles.radius, '0px'); assert.equal(styles.material, 'solid'); assert.equal(styles.frame, 'false');
  await pause(500); await feedback.screenshot({ path: path.join(out, 'feedback-solid.png') });
  assert.equal(await feedback.evaluate(async () => { try { await window.desktop.view('toggle-maximize'); return false; } catch { return true; } }), true);
  await feedback.getByRole('button', { name: '历史回顾', exact: true }).click();
  await waitNative('history', s => s.focused); await nativeOrder('history');
  await waitNative('feedback', s => !s.visible);
  report.checks.push('feedback shares opaque body/header/footer with settings/history, no Acrylic native mask; feedback navigation focuses target; controls rejected from capsule/feedback');
  const panel = await open('panel');
  await panel.getByRole('button', { name: '延迟 3 秒不激活展示卡片', exact: true }).click();
  await waitNative('feedback', s => s.visible);
  assert.equal((await nativeState('panel')).focused, true);
  report.checks.push('explicit inactive feedback preview preserves keyboard focus');
  const before = await orb.evaluate(() => window.desktop.state());
  await app.evaluate(() => windowFixture.publish({ phase: 'recording', recording: true, busy: false, startedAt: null, elapsedMs: 2500 }));
  await open('settings'); await settings.getByRole('button', { name: '最小化', exact: true }).click(); await waitNative('settings', s => s.minimized);
  await open('settings'); await settings.getByRole('button', { name: '最大化', exact: true }).click(); await waitNative('settings', s => s.maximized);
  const after = await orb.evaluate(() => window.desktop.state());
  assert.equal(after.phase, 'recording'); assert.equal(after.recording, true); assert.equal(after.roundId, before.roundId);
  await app.evaluate(() => windowFixture.publish({ phase: 'feedback', recording: false, busy: false }));
  const prefs = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => w.webContents.getLastWebPreferences()));
  assert.ok(prefs.every(p => p.contextIsolation && p.sandbox && !p.nodeIntegration && p.webSecurity));
  report.checks.push('window actions leave synthetic recording/session intact and retain renderer security');
  assert.deepEqual(report.errors, []); report.completed = true;
} catch (error) { report.failure = String(error.stack || error); process.exitCode = 1; }
finally {
  if (app) await app.close().catch(() => {});
  await finishMain(report, out);
  await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ out, completed: report.completed, checks: report.checks, failure: report.failure, errors: report.errors }, null, 2));
}
