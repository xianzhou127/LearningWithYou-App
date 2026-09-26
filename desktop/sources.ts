import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { SourceChoice } from "./shared";

export type NativeWindow = { id: string; name: string; pid: number; processName: string; minimized: boolean };
export type NativeMonitor = { id: string; device: string; primary: boolean; x: number; y: number; width: number; height: number };
export type NativeCatalog = { windows: NativeWindow[]; monitors: NativeMonitor[] };
const runFile = promisify(execFile);

export async function readNativeCatalog(): Promise<NativeCatalog> {
  // Fixed bundled executable, no shell and no renderer-supplied path or arguments.
  const directory = __dirname.replace(/app\.asar(?=[\\/]|$)/, "app.asar.unpacked");
  const { stdout } = await runFile(path.join(directory, "native/source-catalog.exe"), [], { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024, encoding: "utf8" });
  const catalog = JSON.parse(stdout) as NativeCatalog;
  if (!Array.isArray(catalog.windows) || !Array.isArray(catalog.monitors) || !catalog.monitors.length) throw new Error("Invalid native source catalog");
  return catalog;
}

export function windowChoices(catalog: NativeCatalog, ownIds: Set<string>, processId: number, thumbnails: Map<string, string>): SourceChoice[] {
  return catalog.windows.filter(w => w.pid !== processId && !ownIds.has(w.id)).map(w => ({
    id: w.id, name: w.name.slice(0, 256), kind: "window", thumbnail: w.minimized ? "" : thumbnails.get(w.id) ?? "",
    available: !w.minimized, detail: `${w.processName || "应用窗口"} · ${w.minimized ? "已最小化，请先恢复后刷新" : "已打开"}`,
  }));
}
