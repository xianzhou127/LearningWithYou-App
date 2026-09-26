// Real packaged UI with generated video/text only. No screen/microphone/service.
import { _electron as electron } from 'playwright';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { watchMain, finishMain } from './main-errors.mjs';

const directory = JSON.parse(await readFile('release/latest.json', 'utf8')).directories[0];
const out = path.resolve('artifacts/smoke/appearance-' + new Date().toISOString().replace(/[:.]/g, '-'));
const screenshots = process.argv.includes('--screenshots') ? path.resolve('docs/screenshots') : out;
await mkdir(out, { recursive: true }); await mkdir(screenshots, { recursive: true });
const profile = await mkdtemp(path.join(os.tmpdir(), 'LearningWithYou-App-appearance-'));
await mkdir(path.join(profile, 'appearance-v1'));
await writeFile(path.join(profile, 'appearance-v1/material-v1.json'), JSON.stringify({ application: 'LearningWithYou', schema: 1, kind: 'material', settings: { highlightStrength: 3 }, startupEnabled: false }));
const report = { completed: false, checks: [], errors: [], scope: 'Packaged UI, generated canvas video, synthetic feedback; no real screen, microphone or API.' };
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
let app;
const pause = ms => new Promise(r => setTimeout(r, ms));
async function page(role) {
  for (let i = 0; i < 150; i++) { const p = app.windows().find(p => p.url().endsWith('?role=' + role)); if (p) { p.setDefaultTimeout(15000); return p; } await pause(100); }
  throw new Error('Missing role: ' + role);
}
async function launch() {
  app = await electron.launch({ executablePath: path.join(directory, 'LearningWithYou-App.exe'), cwd: directory, args: [`--user-data-dir=${profile}`], env });
  await watchMain(app, out); app.on('window', p => p.on('pageerror', e => report.errors.push(String(e))));
  const orb = await page('orb'); await orb.locator('.learning-toolbar').waitFor();
  await orb.evaluate(() => {
    // Replace the browser capture API before enabling material, not app code.
    window.syntheticTracks = [];
    navigator.mediaDevices.getUserMedia = async () => { throw new Error('Microphone forbidden in smoke check'); };
    navigator.mediaDevices.getDisplayMedia = async constraints => {
      const canvas = document.createElement('canvas');
      canvas.width = constraints.video.width.ideal; canvas.height = constraints.video.height.ideal;
      const ctx = canvas.getContext('2d'); let frame = 0;
      const draw = () => {
        const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
        gradient.addColorStop(0, '#d4e9ed'); gradient.addColorStop(.45, '#eadbcc'); gradient.addColorStop(1, '#b1cabf');
        ctx.fillStyle = gradient; ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#ffffff88'; ctx.fillRect(90, 70, canvas.width - 180, canvas.height - 140);
        ctx.fillStyle = '#44584f'; ctx.font = '28px sans-serif'; ctx.fillText('合成阅读资料 · Self-explanation', 125, 145);
        ctx.fillStyle = '#94b7b966'; ctx.beginPath(); ctx.arc(canvas.width * .7 + Math.sin(frame++ / 90) * 20, canvas.height * .5, 180, 0, Math.PI * 2); ctx.fill();
      };
      draw(); const timer = setInterval(draw, 33), stream = canvas.captureStream(30);
      for (const track of stream.getTracks()) { const stop = track.stop.bind(track); track.stop = () => { clearInterval(timer); stop(); }; window.syntheticTracks.push(track); }
      return stream;
    };
  });
  return orb;
}
async function openAppearance() {
  await app.evaluate(({ app }) => {
    const r = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json');
    const win = r('./main.cjs').appearance.openTuner(); win.show(); win.focus();
  });
  const p = await page('appearance'); await p.getByRole('heading', { name: '外观调参', exact: true }).waitFor(); return p;
}
try {
  let orb = await launch(); let appearance = await openAppearance();
  const initial = await appearance.evaluate(() => window.appearance.config());
  assert.equal(initial.startupEnabled, false);
  await appearance.getByRole('button', { name: '开启液态玻璃', exact: true }).click();
  await appearance.waitForFunction(async () => { const t = await window.appearance.telemetry(); return t?.liveTracks > 0 && t?.renderFrames > 2; }, null, { timeout: 30000 });
  report.checks.push('packaged glass renders generated video with actual WebGL; real display capture and microphone replaced/denied');
  await appearance.evaluate(async () => { await window.appearance.tune({ highlightStrength: 2.7 }); await window.appearance.configure({ motion: { pull: 18 } }); });
  await appearance.locator('#motion-tuning').scrollIntoViewIfNeeded();
  await appearance.screenshot({ path: path.join(screenshots, 'appearance.png') });
  await appearance.getByRole('button', { name: '保存材质参数', exact: true }).click();
  await appearance.getByRole('button', { name: '保存动效参数', exact: true }).click();
  await appearance.waitForFunction(async () => { const c = await window.appearance.config(); return !c.saved.material.dirty && !c.saved.motion.dirty && !!c.saved.motion.savedAt; });
  await orb.evaluate(() => window.desktop.view('settings')); const settings = await page('settings');
  await settings.getByRole('button', { name: '添加分析配置', exact: true }).waitFor();
  await settings.screenshot({ path: path.join(screenshots, 'settings.png') });
  const feedback = '## 你抓住了核心关系\n\n你说明了速度变化与加速度的联系，并用匀加速运动解释位移。\n\n### 再补上一点\n\n公式 $s = v_0 t + \\frac{1}{2}at^2$ 需要加速度保持不变。\n\n- 先明确初速度 $v_0$ 与方向。\n- 再说明时间区间内 $a$ 是否恒定。\n\n> 这是合成资料的界面示例，不是模型实际回复。';
  await app.evaluate(({ app, ipcMain }, text) => {
    const r = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json');
    r('./main.cjs').learning.publish({ simulated: true, phase: 'feedback', recording: false, sessionId: 1, roundId: 1,
      source: { id: 'synthetic', name: '合成资料 · 匀加速运动', kind: 'window' },
      feedback: text, analysis: { ok: true, mode: 'text', result: { message: text }, details: null } });
    ipcMain.removeHandler('t10:sources'); ipcMain.handle('t10:sources', () => []);
  }, feedback);
  await orb.evaluate(() => window.desktop.view('feedback')); const feedbackPage = await page('feedback');
  await feedbackPage.locator('math').first().waitFor();
  await feedbackPage.screenshot({ path: path.join(screenshots, 'feedback.png') });
  report.checks.push('actual settings, feedback and MathML render with synthetic content; screenshots contain no user material');
  await orb.evaluate(() => window.desktop.view('collapse'));
  await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) if (!w.webContents.getURL().endsWith('?role=orb')) w.hide(); });
  await orb.getByRole('button', { name: '更多', exact: true }).click();
  const menu = orb.getByRole('main', { name: '更多学习操作', exact: true }); await menu.waitFor();
  await pause(800);
  const a = await orb.locator('.learning-toolbar').boundingBox(), b = await menu.boundingBox();
  const x = Math.max(0, Math.min(a.x, b.x) - 8), y = Math.max(0, Math.min(a.y, b.y) - 8);
  await orb.screenshot({ path: path.join(screenshots, 'capsule-menu.png'), clip: { x, y, width: Math.max(a.x+a.width,b.x+b.width)-x+8, height: Math.max(a.y+a.height,b.y+b.height)-y+8 } });
  const telemetry = await appearance.evaluate(() => window.appearance.telemetry());
  assert.ok(telemetry.liveTracks > 0); report.gpu = { gl: telemetry.gl, renderFrames: telemetry.renderFrames, liveTracks: telemetry.liveTracks };
  await orb.evaluate(() => window.desktop.view('collapse')); appearance = await openAppearance();
  await appearance.getByRole('button', { name: '关闭材质', exact: true }).click();
  await orb.waitForFunction(() => window.syntheticTracks.every(t => t.readyState === 'ended'));
  report.checks.push('disabling material stops all generated capture tracks');
  await app.close(); orb = await launch(); appearance = await openAppearance();
  const recovered = await appearance.evaluate(() => window.appearance.config());
  assert.equal(recovered.material.highlightStrength, 2.7); assert.equal(recovered.motion.pull, 18); assert.equal(recovered.startupEnabled, false);
  const state = await orb.evaluate(() => window.desktop.state()); assert.equal(state.recording, false); assert.equal(state.analysis, null);
  report.checks.push('material and motion save/restart restore values without recording or analysis');
  assert.deepEqual(report.errors, []); report.completed = true;
} catch (error) { report.failure = String(error.stack || error); process.exitCode = 1; }
finally {
  if (app) await app.close().catch(() => {}); await finishMain(report, out);
  await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ out, ...report }, null, 2));
}
