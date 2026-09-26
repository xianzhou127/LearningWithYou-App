import { readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
export const baseResources = ["main.cjs", "preload.cjs", "media-preload.cjs", "package.json", "native/source-catalog.exe", "renderer/index.html", "renderer/media.html", "renderer/ui.js", "renderer/ui.js.LEGAL.txt", "renderer/ui.css", "renderer/media.js", "renderer/pcm-worklet.js"];
export async function runtimeResources() {
  const sharpRoot = path.resolve(path.dirname(require.resolve("sharp")), "..");
  const fromSharp = createRequire(path.join(sharpRoot, "package.json"));
  const roots = {
    sharp: sharpRoot,
    ws: path.dirname(require.resolve("ws/package.json")),
    "@img/colour": path.dirname(fromSharp.resolve("@img/colour/package.json")),
    "detect-libc": path.dirname(fromSharp.resolve("detect-libc/package.json")),
    semver: path.dirname(fromSharp.resolve("semver/package.json")),
    "@img/sharp-win32-x64": path.resolve(sharpRoot, "../@img/sharp-win32-x64"),
  };
  const rules = {
    sharp: /^dist\/[^/]+\.cjs$/,
    ws: /^(index\.js|lib\/[^/]+\.js)$/,
    "@img/colour": /^(color|index)\.cjs$/,
    "detect-libc": /^lib\/[^/]+\.js$/,
    semver: /^(index\.js|(?:classes|functions|internal|ranges)\/[^/]+\.js)$/,
    "@img/sharp-win32-x64": /^(index\.cjs|versions\.json|lib\/[^/]+\.(node|dll))$/,
  };
  const resources = [];
  async function walk(dir, prefix = "") {
    const files = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error("Runtime package contains unexpected link");
      if (entry.isDirectory()) files.push(...await walk(path.join(dir, entry.name), prefix + entry.name + "/"));
      else files.push(prefix + entry.name);
    }
    return files;
  }
  for (const [name, source] of Object.entries(roots)) {
    const directory = await realpath(source);
    for (const file of await walk(directory)) {
      if (/^(package\.json|LICEN[CS]E(?:.*)?|NOTICE(?:.*)?|README(?:.*)?)$/.test(file) || rules[name].test(file)) resources.push({ source: path.join(directory, file), file: `node_modules/${name}/${file}` });
    }
  }
  return resources;
}
