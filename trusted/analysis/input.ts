import "../node-only";
import sharp from "sharp";
import { boundedText, hasExactKeys, isRecord, type AnalysisInput } from "../../shared/analysis-contract";

export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
export const MAX_REQUEST_BYTES = 9 * 1024 * 1024;
const MAX_PIXELS = 16_000_000;

async function validImage(value: unknown): Promise<boolean> {
  if (typeof value !== "string" || value.length > 4 * Math.ceil(MAX_IMAGE_BYTES / 3) + 32) return false;
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return false;
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || bytes.toString("base64") !== match[2]) return false;
  try {
    const decoder = sharp(bytes, { failOn: "warning", limitInputPixels: MAX_PIXELS });
    const meta = await decoder.metadata();
    if (meta.format !== match[1] || !meta.width || !meta.height ||
        meta.width < 10 || meta.height < 10 || meta.width > 8192 || meta.height > 8192 ||
        meta.width * meta.height > MAX_PIXELS || (meta.pages ?? 1) !== 1) return false;
    // Metadata alone accepts truncated/corrupt images; decode every pixel in memory.
    await decoder.raw().toBuffer();
    return true;
  } catch { return false; }
}

export async function validateInput(value: unknown): Promise<AnalysisInput | null> {
  if (!isRecord(value) || !hasExactKeys(value, ["start_screenshot", "end_screenshot", "transcript"]) ||
      !boundedText(value.transcript, 1, 8000) || !value.transcript.trim()) return null;
  // Decode sequentially to bound peak image memory.
  if (!await validImage(value.start_screenshot) || !await validImage(value.end_screenshot)) return null;
  return {
    start_screenshot: value.start_screenshot as string,
    end_screenshot: value.end_screenshot as string,
    transcript: value.transcript,
  };
}

export async function readBoundedJson(
  body: ReadableStream<Uint8Array> | null, maxBytes: number, signal: AbortSignal,
): Promise<unknown> {
  if (!body || signal.aborted) throw new Error("unreadable_body");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const onAbort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw new Error("aborted");
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error("body_too_large");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } finally {
    signal.removeEventListener("abort", onAbort);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
    chunks.length = 0;
  }
}
