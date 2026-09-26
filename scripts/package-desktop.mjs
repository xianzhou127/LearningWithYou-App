import { packager } from "@electron/packager";
import { readFile, writeFile, readdir, stat, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { licenseResources } from "./licenses.mjs";
import { baseResources, runtimeResources } from "./desktop-resources.mjs";
import { execFileSync } from "node:child_process";
const require = createRequire(import.meta.url);
const asar = createRequire(require.resolve("@electron/packager"))("@electron/asar");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "dist");
const allowed = new Set([...baseResources, "LICENSE", "THIRD_PARTY_NOTICES.md", ...(await licenseResources()).map(r => r.file), "renderer/glass.html", "renderer/glass.js", "renderer/glass.js.LEGAL.txt", "renderer/glass.css", "glass/LICENSE.txt", "glass/UPSTREAM.md", "glass/presets/static-accepted24.json", "glass/presets/motion-accepted10.json", ...(await runtimeResources()).map(resource => resource.file)]);
async function files(dir, prefix = "") { const result = []; for (const e of await readdir(dir, { withFileTypes: true })) { const name = `${prefix}${e.name}`; if (e.isSymbolicLink()) throw new Error("Symlinks are not packaged"); if (e.isDirectory()) result.push(...await files(path.join(dir, e.name), `${name}/`)); else result.push(name); } return result; }
const staged = await files(source);
for (const file of staged) if (!allowed.has(file)) throw new Error(`Unexpected staging file: ${file}`);
for (const file of allowed) if (!staged.includes(file)) throw new Error(`Missing staging file: ${file}`);
const manifest = await Promise.all(staged.map(async file => ({ file, sha256: createHash("sha256").update(await readFile(path.join(source, file))).digest("hex") })));
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const desktopVersion = JSON.parse(await readFile(path.join(source, "package.json"), "utf8")).version;
const paths = await packager({ dir: source, out: path.join(root, "release", stamp), name: "LearningWithYou-App", executableName: "LearningWithYou-App", platform: "win32", arch: "x64", electronVersion: pkg.devDependencies.electron, asar: { unpackDir: "{native,node_modules}" }, prune: false, overwrite: false, appVersion: desktopVersion, win32metadata: { CompanyName: "Local Learning", FileDescription: "Self-explanation learning desktop app", ProductName: "LearningWithYou App" } });
for (const dir of paths) {
  if (!asar.statFile(path.join(dir, "resources/app.asar"), "native/source-catalog.exe").unpacked) throw new Error("Native source catalog must be unpacked for execution");
  const nativeBytes = await readFile(path.join(dir, "resources/app.asar.unpacked/native/source-catalog.exe"));
  if (createHash("sha256").update(nativeBytes).digest("hex") !== manifest.find(f => f.file === "native/source-catalog.exe").sha256) throw new Error("Unpacked native helper hash mismatch");
  await copyFile(path.join(root, "docs/ACCEPTANCE.md"), path.join(dir, "ACCEPTANCE.md"));
  const packedManifest = manifest.map(file => {
    const sha256 = createHash("sha256").update(asar.extractFile(path.join(dir, "resources/app.asar"), path.normalize(file.file))).digest("hex");
    if (file.file !== "package.json" && file.sha256 !== sha256) throw new Error(`Packaged content mismatch: ${file.file}`);
    return { ...file, sha256, stagingSha256: file.sha256 };
  });
  // Fail without opening application windows if a runtime dependency was omitted.
  execFileSync(path.join(dir, "LearningWithYou-App.exe"), ["-e", "const p=require('node:path'),r=require('node:module').createRequire(p.resolve(process.argv[1],'node_modules/sharp/package.json'));const s=r('sharp');r('ws');s({create:{width:20,height:20,channels:3,background:'green'}}).jpeg().toBuffer().then(b=>s(b).raw().toBuffer()).then(b=>{if(b.length!==1200)process.exit(1)}).catch(()=>process.exit(1));", path.join(dir, "resources/app.asar.unpacked")], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, windowsHide: true, timeout: 15000, stdio: "pipe" });
  await writeFile(path.join(dir, "START-HERE.txt"), `自我解释学习助手 ${desktopVersion}（独立工程候选，待用户验收）\r\n双击 LearningWithYou-App.exe，无需网页服务，保留整个目录。\r\n工具条更多 → 设置 → 分析或 ASR 栏点击添加，在弹窗填写并保存。分析填 Key、URL、模型；无鉴权本地服务 Key 留空。ASR 选择百炼（北京）并填 Key。保存后加入列表并选中；切换列表立即保存，删除只移除选中项并回到未选择，不自动改用其他配置。两类配置独立加密保存，原 v1/v2 自动迁移到 v3 列表。包不读取项目 .env.local。\r\n明确开始后录音和云端转写，点击结束并检查后等待最终转写和真实分析。音频发给百炼 ASR；两张截图和转写发给所配置的分析服务。本地分析搭配云端 ASR 仍需联网。\r\n反馈卡片和本轮详情支持 Markdown 标题、加粗、列表、引用、表格和代码块。\r\n失败不会自动重试或回退演示；分析失败可保留素材手动重试。\r\n连续下一轮复用来源，更换资料可手动切换，退出释放全部资源。整屏黑块继续暂缓。\r\n菜单 → 历史回顾，查看截图、录音、最终转写和反馈，支持单条删除及确认全部清除。数据保存在用户数据目录的 history-v1；配置沿用 T11。按 ACCEPTANCE.md 验收。\r\n液态玻璃默认开启，自动适配已连接屏幕，无需选屏；主胶囊右键 → 外观调参。材质和动效独立保存；恢复预设先预览。关闭调参窗不影响学习。\r\n`, "utf8");
  await writeFile(path.join(dir, "package-manifest.json"), JSON.stringify({ builtAt: stamp, electron: pkg.devDependencies.electron, packagedFiles: packedManifest, packageMetadataSanitizedByPackager: true, sourcePolicy: "Only explicit desktop-dist allowlist. No environment files, web server, private materials or historical reports." }, null, 2));
  let total = 0; for (const f of await files(dir)) total += (await stat(path.join(dir, f))).size;
  console.log(JSON.stringify({ directory: dir, executable: path.join(dir, "LearningWithYou-App.exe"), bytes: total, MiB: +(total / 1024 / 1024).toFixed(2) }, null, 2));
}
await writeFile(path.join(root, "release/latest.json"), JSON.stringify({ directories: paths }, null, 2));
