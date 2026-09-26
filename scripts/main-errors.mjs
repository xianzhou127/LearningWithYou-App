// External test instrumentation: every suppressed modal becomes a test failure.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
export async function watchMain(app, out) {
  await app.evaluate(({ dialog }, file) => {
    const fs = process.getBuiltinModule('fs');
    dialog.showErrorBox = (title, content) => fs.appendFileSync(file, JSON.stringify({ title, content }) + '\n');
    process.on('uncaughtExceptionMonitor', error => fs.appendFileSync(file, JSON.stringify({ uncaught: String(error.stack || error) }) + '\n'));
  }, path.join(out, 'main-errors.jsonl'));
}
export async function finishMain(report, out) {
  const text = await readFile(path.join(out, 'main-errors.jsonl'), 'utf8').catch(() => '');
  report.mainExceptions = text.trim() ? text.trim().split('\n').map(s => JSON.parse(s)) : [];
  if (report.mainExceptions.length) { report.completed = false; process.exitCode = 1; }
}
