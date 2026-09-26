import { build } from "esbuild";
import { mkdir, copyFile, writeFile, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { licenseResources } from "./licenses.mjs";
import { runtimeResources } from "./desktop-resources.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const out = path.join(root, "dist");
await mkdir(path.join(out, "renderer"), { recursive: true });
if (process.platform !== "win32") throw new Error("Native source catalog requires a Windows x64 build host");
await mkdir(path.join(out, "native"), { recursive: true });
const compiler = path.join(process.env.WINDIR || "C:/Windows", "Microsoft.NET/Framework64/v4.0.30319/csc.exe");
execFileSync(compiler, ["/nologo", "/target:exe", "/platform:x64", "/optimize+", "/reference:System.Web.Extensions.dll", `/out:${path.join(out, "native/source-catalog.exe")}`, path.join(root, "desktop/native/source-catalog.cs")], { windowsHide: true, stdio: "inherit" });
await build({ entryPoints: [path.join(root, "desktop/main.ts")], outfile: path.join(out, "main.cjs"), platform: "node", target: "node24", format: "cjs", bundle: true, external: ["electron", "sharp", "ws"] });
for (const entry of ["preload", "media-preload"]) await build({ entryPoints: [path.join(root, `desktop/${entry}.ts`)], outfile: path.join(out, `${entry}.cjs`), platform: "node", format: "cjs", bundle: true, external: ["electron"] });
for (const [name, entry] of [["ui", "ui.tsx"], ["media", "media.ts"], ["glass", "glass/entry.tsx"]]) {
  const result = await build({ entryPoints: [path.join(root, `desktop/${entry}`)], outfile: path.join(out, `renderer/${name}.js`), platform: "browser", target: "chrome152", format: "iife", bundle: true, minify: true, metafile: true, define: { "process.env.NODE_ENV": '"production"' }, legalComments: "linked" });
  if (Object.keys(result.metafile.inputs).some(file => /(?:trusted|server)\//.test(file) || /desktop\/(config|services|main|history|window-preferences)\.ts/.test(file))) throw new Error("Trusted code entered a renderer build");
  if (Object.keys(result.metafile.inputs).some(file => /experiments\//.test(file) || /glass\/(host|settings-store)\.ts/.test(file))) throw new Error("Experiment or trusted appearance code entered a renderer build");
}
await copyFile(path.join(root, 'desktop/glass/index.html'), path.join(out, 'renderer/glass.html'));
await mkdir(path.join(out, 'glass/presets'), { recursive: true });
await copyFile(path.join(root, 'desktop/glass/upstream/LICENSE.txt'), path.join(out, 'glass/LICENSE.txt'));
await copyFile(path.join(root, 'desktop/glass/UPSTREAM.md'), path.join(out, 'glass/UPSTREAM.md'));
for (const file of ['static-accepted24.json', 'motion-accepted10.json']) await copyFile(path.join(root, 'desktop/glass/presets', file), path.join(out, 'glass/presets', file));
for (const name of ["index.html", "media.html"]) await copyFile(path.join(root, "desktop", name), path.join(out, "renderer", name));
await copyFile(path.join(root, "public/pcm-worklet.js"), path.join(out, "renderer/pcm-worklet.js"));
for (const resource of [...await runtimeResources(), ...await licenseResources()]) { const target = path.join(out, resource.file); await mkdir(path.dirname(target), { recursive: true }); await copyFile(resource.source, target); }
for (const file of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) await copyFile(path.join(root, file), path.join(out, file));
// Keep the installed application identity stable so T11 encrypted configuration remains readable.
await writeFile(path.join(out, "package.json"), JSON.stringify({ name: "learning-with-you-t11", productName: "LearningWithYou T11", version: pkg.version, description: pkg.description, private: true, main: "main.cjs" }, null, 2));
const allowed = new Set(["main.cjs", "preload.cjs", "media-preload.cjs", "package.json", "renderer", "native", "node_modules", "glass", "licenses", "THIRD_PARTY_NOTICES.md", "LICENSE"]);
for (const entry of await readdir(out)) if (!allowed.has(entry)) throw new Error(`Unknown staging entry: ${entry}. Refusing to package.`);
console.log(`Desktop local bundle ready: ${out}`);
