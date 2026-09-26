import { build } from 'esbuild';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = path.join(root, 'artifacts/glass', 'optics-gpu-' + new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(run, { recursive: true });
await build({ entryPoints: [path.join(root, 'desktop/tests/glass/optics-gpu.ts')], outfile: path.join(run, 'check.js'), bundle: true, platform: 'browser', target: 'chrome152',
  // This fixture exercises DesktopSession only with simulated services. Keep
  // Node config parsers out of this test renderer without weakening production.
  plugins: [{ name: 'gpu-fixture-config-boundary', setup(build) {
    build.onResolve({ filter: /trusted\/(analysis\/configuration|asr-configuration)$/ }, () => ({ path: path.join(root, 'desktop/tests/glass/unused-config.ts') }));
  } }],
});
await writeFile(path.join(run, 'index.html'), '<!doctype html><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\'"><link rel="stylesheet" href="check.css"><body><script src="check.js"></script></body>');
await writeFile(path.join(run, 'main.cjs'), `const { app, BrowserWindow } = require('electron');
const path = require('node:path'); const fs = require('node:fs');
app.setPath('userData', path.join(__dirname, 'data'));
const timeout=setTimeout(()=>{console.error('Optics check timed out');app.exit(1);},60000);
app.whenReady().then(async()=>{
  const w=new BrowserWindow({show:false,width:64,height:64,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,devTools:false,backgroundThrottling:false}});
  w.setContentProtection(true);
  // Visible but inactive: Chromium does not deliver video presentation callbacks
  // to a window that has never been shown. Capture exclusion stays enabled.
  w.showInactive();
  w.webContents.session.setPermissionRequestHandler((_w,_p,callback)=>callback(false));
  w.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','ws://*/*','wss://*/*']},(_d,callback)=>callback({cancel:true}));
  await w.loadFile(path.join(__dirname,'index.html'));
  const result=await w.webContents.executeJavaScript('window.opticsCheck');
  fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify(result,null,2));
  clearTimeout(timeout);w.destroy();app.exit(result?.ok?0:1);
}).catch(error=>{console.error(error);app.exit(1);});
`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const exitCode = await new Promise((resolve, reject) => {
  const child = spawn(electron, [path.join(run, 'main.cjs')], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on('data', chunk => process.stderr.write(chunk));
  child.on('error', reject); child.on('exit', resolve);
});
try { console.log(await readFile(path.join(run, 'result.json'), 'utf8')); } catch { /* Electron startup errors appear on stderr. */ }
console.log('Numeric GPU evidence: ' + run);
process.exitCode = exitCode === 0 ? 0 : 1;
