// Collect full notices from the installed production dependency graph, including
// packages bundled into renderer JS. Development tooling is not redistributed.
import { readFile, readdir, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function licenseResources() {
  const resources = [], seen = new Set();
  async function visit(directory) {
    directory = await realpath(directory);
    if (seen.has(directory)) return;
    seen.add(directory);
    const pkg = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
    const req = createRequire(path.join(directory, 'package.json'));
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      // Some native distributions put their third-party license table in README.
      if (entry.isFile() && /^(licen[cs]e|copying|notice|authors|readme)([.-]|$)/i.test(entry.name)) {
        resources.push({ source: path.join(directory, entry.name), file: `licenses/${pkg.name.replace('/', '__')}@${pkg.version}/${entry.name}` });
      }
    }
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
      let child;
      // Native packages can export only a binary subpath and forbid both the
      // package.json subpath and bare import. Resolve their on-disk metadata
      // through Node's normal lookup directories before applying exports.
      for (const base of req.resolve.paths(name) ?? []) {
        const candidate = path.join(base, name);
        try { if (JSON.parse(await readFile(path.join(candidate, 'package.json'), 'utf8')).name === name) { child = candidate; break; } } catch { /* not installed here */ }
      }
      if (child) { await visit(child); continue; }
      try { child = path.dirname(req.resolve(name + '/package.json')); }
      catch {
        try {
          child = path.dirname(req.resolve(name));
          while (true) {
            try { if (JSON.parse(await readFile(path.join(child, 'package.json'), 'utf8')).name === name) break; } catch { /* nested dist folder */ }
            const parent = path.dirname(child); if (parent === child) throw new Error('Missing package root: ' + name); child = parent;
          }
        } catch (error) { if (pkg.optionalDependencies?.[name]) continue; throw error; }
      }
      await visit(child);
    }
  }
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  for (const name of Object.keys(pkg.dependencies)) await visit(path.join(root, 'node_modules', name));
  return resources.sort((a, b) => a.file.localeCompare(b.file));
}
