import "../trusted/node-only";
import { copyFile, mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { WindowPreferencesStatus } from "./shared";

// Window preferences are independent of credentials, appearance and learning history.
// contentProtection controls other windows; capsule/menu exclusion is mandatory.
export class WindowPreferencesStore {
  private contentProtection = false;
  private error: WindowPreferencesStatus["error"] = null;
  constructor(private directory: string) {}
  private file() { return path.join(this.directory, "window-preferences-v1.json"); }
  status(): WindowPreferencesStatus { return { contentProtection: this.contentProtection, error: this.error }; }
  async load() {
    this.contentProtection = false; this.error = null;
    try {
      const handle = await open(this.file(), "r");
      let value: unknown;
      try {
        if (!(await handle.stat()).isFile()) throw new Error("Invalid file");
        const buffer = Buffer.alloc(4097);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > 4096) throw new Error("File too large");
        value = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
      } finally { await handle.close(); }
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid preferences");
      const data = value as Record<string, unknown>;
      if (Object.keys(data).length !== 3 || data.application !== "LearningWithYou" || data.schema !== 1 || typeof data.contentProtection !== "boolean") throw new Error("Invalid preferences");
      this.contentProtection = data.contentProtection;
    } catch (error) {
      // Never replace an unreadable or malformed file during startup.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.error = "read_failed";
    }
  }
  async save(contentProtection: boolean) {
    if (typeof contentProtection !== "boolean") throw new Error("Invalid preference");
    const temporary = `${this.file()}.${randomUUID()}.tmp`;
    try {
      await mkdir(this.directory, { recursive: true });
      await writeFile(temporary, JSON.stringify({ application: "LearningWithYou", schema: 1, contentProtection }, null, 2), { flag: "wx", flush: true });
      try {
        const backups = path.join(this.directory, "window-preferences-backups");
        await mkdir(backups, { recursive: true });
        await copyFile(this.file(), path.join(backups, `${randomUUID()}.json`));
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await rename(temporary, this.file());
      this.contentProtection = contentProtection; this.error = null;
    } catch { this.error = "save_failed"; }
    finally { await unlink(temporary).catch(() => undefined); }
    return this.status();
  }
}
