import "../trusted/node-only";
import sharp from "sharp";
import { randomInt } from "node:crypto";
import { adapterParameters, readConfiguration, requestCompletion, type AnalysisDependencies } from "../trusted/analysis/service";
import type { Configuration } from "./config";
import type { ConnectionTestResult } from "./shared";

export const emptyConnectionTest = (): ConnectionTestResult => ({ reachable: false, text: "pending", image: "pending", imageObservation: null, cancelled: false, error: null });
// No DesktopSession, capture, microphone, or history dependency. Only fixed text
// and two freshly generated solid-color PNGs can reach the selected endpoint.
export async function testAnalysisConnection(env: Configuration, signal: AbortSignal, dependencies: AnalysisDependencies = {}): Promise<ConnectionTestResult> {
  const result = emptyConnectionTest();
  const config = readConfiguration({ ...env, ANALYSIS_OUTPUT_MODE: "text" });
  if (!config) return { ...result, error: "分析配置无效。" };
  const options = { ...dependencies, env: { ...env }, onReachable: () => { result.reachable = true; } };
  const request = (content: unknown) => ({ model: config.model, stream: false, ...adapterParameters(config.adapter), messages: [{ role: "user", content }] });
  const text = await requestCompletion(config, request("这是应用的无敏感连接测试。请仅回复 TEST_OK。"), signal, options);
  if (signal.aborted) return { ...result, cancelled: true };
  result.text = text.ok ? "passed" : "failed";
  if (!text.ok) return { ...result, error: text.error.message };
  const palette = [{ name: "RED", hex: "#ff0000" }, { name: "BLUE", hex: "#0000ff" }, { name: "GREEN", hex: "#00ff00" }, { name: "YELLOW", hex: "#ffff00" }];
  const first = randomInt(palette.length), second = (first + 1 + randomInt(palette.length - 1)) % palette.length;
  const colors = [palette[first], palette[second]];
  const images = await Promise.all(colors.map(async color => ({ type: "image_url", image_url: { url: `data:image/png;base64,${(await sharp({ create: { width: 128, height: 128, channels: 3, background: color.hex } }).png().toBuffer()).toString("base64")}` } })));
  if (signal.aborted) return { ...result, cancelled: true };
  const image = await requestCompletion(config, request([{ type: "text", text: "依次识别两张纯色图片。只输出两个英文颜色名称，用空格分隔；从 RED BLUE GREEN YELLOW 中选择。" }, ...images]), signal, options);
  if (signal.aborted) return { ...result, cancelled: true };
  result.image = image.ok ? "passed" : "failed";
  if (!image.ok) return { ...result, error: image.error.message };
  const observed = image.result.message.toUpperCase().match(/\b(?:RED|BLUE|GREEN|YELLOW)\b/g);
  result.imageObservation = observed?.join(" ") === colors.map(c => c.name).join(" ") ? "matched" : "unconfirmed";
  return result;
}
