import "./node-only";
import { randomUUID } from "node:crypto";
import WebSocket, { type RawData } from "ws";
import { DEFAULT_ASR_PROVIDER, getAsrPreset, type AsrPreset } from "../shared/asr-providers";
const MAX_PENDING_AUDIO_BYTES = 8 * 1024 * 1024;
const MAX_AUDIO_CHUNK_BYTES = 256 * 1024;

type ProxyErrorCode =
  | "missing-api-key"
  | "empty-audio"
  | "audio-format"
  | "connection-timeout"
  | "network-interruption"
  | "service-error";

export type AsrProxyOptions = {
  apiKeyProvider: () => string | undefined;
  provider?: string;
  // Trusted test dependency only; never accepted from renderer configuration.
  upstreamUrl?: string;
  taskStartTimeoutMs?: number;
  taskFinishTimeoutMs?: number;
  onDiagnostic?: (event: AsrDiagnostic) => void;
};

type FailureReason = "capacity" | "unavailable" | "rate_limit" | "quota" | "authentication" | "audio_format" | "unknown";
export type AsrDiagnostic = {
  timestamp: string;
  model: string;
  stage: "task-failed" | "handshake";
  reason: FailureReason;
  upstreamCode: string;
  taskId: string;
  elapsedMs: number;
  audioBytes: number;
  httpStatus: number | null;
};

// Only known technical codes may enter diagnostics, never arbitrary upstream strings.
const diagnosticCodes = new Set([
  "ServiceUnavailable", "SERVICE_UNAVAILABLE", "ModelUnavailable", "ModelServingError",
  "Throttling", "Throttling.RateQuota", "Throttling.AllocationQuota", "Throttling.Concurrency",
  "LimitRequests", "TooManyRequests", "ResourceExhausted", "Arrearage", "AccessDenied",
  "InvalidApiKey", "InvalidParameter", "INVALID_AUDIO_FORMAT", "CLIENT_ERROR", "SERVER_ERROR",
]);

type UpstreamEvent = {
  header?: {
    task_id?: string;
    event?: string;
    error_code?: string;
    error_message?: string;
  };
  payload?: {
    output?: {
      sentence?: {
        text?: string;
        heartbeat?: boolean;
        sentence_end?: boolean;
        sentence_id?: number;
      };
    };
  };
};

function asBuffer(data: RawData) {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  throw new TypeError("Unsupported WebSocket frame type.");
}

function getTaskFailureReason(event: UpstreamEvent): FailureReason {
  const details = `${event.header?.error_code ?? ""} ${event.header?.error_message ?? ""}`;
  if (/system capacity|capacity limits|overload/i.test(details)) return "capacity";
  if (/ServiceUnavailable|SERVICE_UNAVAILABLE|ModelUnavailable|ModelServingError/i.test(details)) return "unavailable";
  if (/free.*quota|quota.*exhaust|arrear|balance|credit.*exceed/i.test(details)) return "quota";
  if (/Throttling|TooManyRequests|LimitRequests|ResourceExhausted|rate.*exceed|too many requests/i.test(details)) return "rate_limit";
  if (/InvalidApiKey|AccessDenied|authentication|permission denied/i.test(details)) return "authentication";
  if (/audio|codec|format|pcm|sample.?rate/i.test(details)) return "audio_format";
  return "unknown";
}

function getTaskFailureMessage(reason: FailureReason) {
  const messages: Record<FailureReason, string> = {
    capacity: "百炼语音服务当前繁忙或容量不足，请稍后重新开始。剩余使用额度不代表服务此刻一定可用。",
    unavailable: "百炼语音服务暂时不可用，请稍后重新开始。",
    rate_limit: "语音请求触发百炼限流，请稍后重新开始，并检查该语音模型的请求频率和并发限制。",
    quota: "百炼提示当前语音模型的额度或账户状态异常，请到控制台核对后再试。",
    authentication: "百炼语音鉴权或模型权限检查失败，请检查服务端密钥和语音模型权限。",
    audio_format: "百炼无法读取这次音频格式，请确认浏览器支持 16 kHz 单声道 PCM 后重试。",
    unknown: "百炼语音转写服务返回错误，请稍后重新录制。",
  };
  return messages[reason];
}


export function createAsrChannel(options: AsrProxyOptions, onMessage: (message: object) => void) {
  const preset = getAsrPreset(options.provider ?? DEFAULT_ASR_PROVIDER);
  if (!preset) {
    let terminal = false;
    return {
      accept() { if (!terminal) { terminal = true; onMessage({ type: "error", code: "service-error", message: "ASR 厂家尚未支持，请在设置中选择已支持的厂家。" }); } },
      cancel() { terminal = true; },
    };
  }
  // Each protocol owns its transport, framing and finish/cancel semantics.
  // New presets cannot be routed through a different manufacturer's protocol.
  const adapters: Record<AsrPreset["protocol"], typeof createBailianChannel> = { "bailian-streaming-v1": createBailianChannel };
  return adapters[preset.protocol](preset, options, onMessage);
}

function createBailianChannel(preset: AsrPreset, options: AsrProxyOptions, onMessage: (message: object) => void) {
  const upstreamUrl = options.upstreamUrl ?? preset.endpoint;
  const taskStartTimeoutMs = options.taskStartTimeoutMs ?? 10000;
  const taskFinishTimeoutMs = options.taskFinishTimeoutMs ?? 10000;
    const connectedAt = Date.now();
    let upstream: WebSocket | null = null;
    let taskId = "";
    let localStarted = false;
    let upstreamTaskStarted = false;
    let finishRequested = false;
    let finishSent = false;
    let terminal = false;
    let audioBytes = 0;
    let pendingAudioBytes = 0;
    let pendingAudio: Buffer[] = [];
    let taskStartTimer: NodeJS.Timeout | null = null;
    let taskFinishTimer: NodeJS.Timeout | null = null;

    const reportFailure = (
      stage: AsrDiagnostic["stage"], reason: FailureReason, upstreamCode?: string, httpStatus: number | null = null,
    ) => {
      const event: AsrDiagnostic = {
        timestamp: new Date().toISOString(), model: preset.model, stage, reason,
        upstreamCode: upstreamCode && diagnosticCodes.has(upstreamCode) ? upstreamCode : "other",
        taskId, elapsedMs: Date.now() - connectedAt, audioBytes, httpStatus,
      };
      // Diagnostics must never change the failure/cleanup behavior.
      try { options.onDiagnostic?.(event); } catch {}
    };

    const clearTimers = () => {
      if (taskStartTimer) {
        clearTimeout(taskStartTimer);
        taskStartTimer = null;
      }
      if (taskFinishTimer) {
        clearTimeout(taskFinishTimer);
        taskFinishTimer = null;
      }
    };

    const sendBrowser = (message: object) => {
      onMessage(message);
    };

    const closeUpstream = () => {
      const socket = upstream;
      upstream = null;
      if (!socket) {
        return;
      }
      socket.removeAllListeners();
      socket.on("error", () => undefined);
      if (socket.readyState === WebSocket.CONNECTING) {
        socket.terminate();
      } else if (socket.readyState === WebSocket.OPEN) {
        socket.close(1000, "proxy-finished");
        const closeTimer = setTimeout(() => socket.terminate(), 1000); closeTimer.unref(); socket.once("close", () => clearTimeout(closeTimer));
      }
    };

    const fail = (code: ProxyErrorCode, message: string) => {
      if (terminal) {
        return;
      }
      terminal = true;
      clearTimers();
      pendingAudio = [];
      pendingAudioBytes = 0;
      sendBrowser({ type: "error", code, message });
      closeUpstream();

    };

    const sendFinishTask = () => {
      if (terminal || finishSent || !upstreamTaskStarted) {
        return;
      }
      if (!audioBytes) {
        fail("empty-audio", "没有检测到可转写的麦克风音频，请说话后再点击检查。");
        return;
      }
      if (!upstream || upstream.readyState !== WebSocket.OPEN) {
        fail("network-interruption", "语音转写连接已经中断，请重新录制。");
        return;
      }

      finishSent = true;
      upstream.send(
        JSON.stringify({
          header: {
            action: "finish-task",
            task_id: taskId,
            streaming: "duplex",
          },
          payload: { input: {} },
        }),
      );
      taskFinishTimer = setTimeout(() => {
        fail("connection-timeout", "等待百炼返回最后一句转写超时，请稍后重试。");
      }, taskFinishTimeoutMs);
    };

    const flushPendingAudio = () => {
      if (!upstreamTaskStarted || !upstream || upstream.readyState !== WebSocket.OPEN) {
        return;
      }
      for (const chunk of pendingAudio) {
        upstream.send(chunk, { binary: true });
      }
      pendingAudio = [];
      pendingAudioBytes = 0;
      if (finishRequested) {
        sendFinishTask();
      }
    };

    const handleUpstreamEvent = (event: UpstreamEvent) => {
      if (terminal || event.header?.task_id !== taskId) {
        return;
      }

      switch (event.header?.event) {
        case "task-started":
          if (upstreamTaskStarted) {
            return;
          }
          upstreamTaskStarted = true;
          if (taskStartTimer) {
            clearTimeout(taskStartTimer);
            taskStartTimer = null;
          }
          sendBrowser({ type: "ready" });
          flushPendingAudio();
          return;
        case "result-generated": {
          const sentence = event.payload?.output?.sentence;
          if (
            !sentence ||
            sentence.heartbeat === true ||
            !Number.isInteger(sentence.sentence_id) ||
            typeof sentence.text !== "string" ||
            typeof sentence.sentence_end !== "boolean"
          ) {
            return;
          }
          sendBrowser({
            type: "transcript",
            sentenceId: sentence.sentence_id,
            text: sentence.text,
            final: sentence.sentence_end,
          });
          return;
        }
        case "task-finished":
          if (!finishSent) { fail("service-error", "语音服务提前结束，本轮转写未完成。"); return; }
          terminal = true;
          clearTimers();
          sendBrowser({ type: "finished" });
          closeUpstream();

          return;
        case "task-failed": {
          const reason = getTaskFailureReason(event);
          reportFailure("task-failed", reason, event.header?.error_code);
          fail(reason === "audio_format" ? "audio-format" : "service-error", getTaskFailureMessage(reason));
          return;
        }
      }
    };

    const startUpstream = () => {
      const apiKey = options.apiKeyProvider()?.trim();
      if (!apiKey) {
        fail(
          "missing-api-key",
          "未配置有效的 ASR 密钥。请在桌面设置中填写独立转写密钥；网页使用 ASR_API_KEY（兼容旧 DASHSCOPE_API_KEY），修改后重启服务。",
        );
        return;
      }

      taskId = randomUUID();
      const socket = new WebSocket(upstreamUrl, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "User-Agent": "LearningWithYou/0.1",
        },
        handshakeTimeout: taskStartTimeoutMs,
        maxPayload: 1024 * 1024,
      });
      upstream = socket;

      taskStartTimer = setTimeout(() => {
        fail("connection-timeout", "连接百炼语音转写服务超时，请检查网络后重试。");
      }, taskStartTimeoutMs);

      socket.on("open", () => {
        if (terminal || upstream !== socket) {
          return;
        }
        socket.send(
          JSON.stringify({
            header: {
              action: "run-task",
              task_id: taskId,
              streaming: "duplex",
            },
            payload: {
              task_group: "audio",
              task: "asr",
              function: "recognition",
              model: preset.model,
              parameters: {
                format: "pcm",
                sample_rate: 16000,
                heartbeat: true,
              },
              input: {},
            },
          }),
        );
      });

      socket.on("message", (data, isBinary) => {
        if (terminal || isBinary) {
          return;
        }
        try {
          handleUpstreamEvent(JSON.parse(asBuffer(data).toString("utf8")) as UpstreamEvent);
        } catch {
          fail("service-error", "百炼返回了无法读取的数据，请稍后重试。");
        }
      });

      socket.on("unexpected-response", (_request, response) => {
        response.resume();
        const status = response.statusCode ?? null;
        const reason: FailureReason = status === 401 || status === 403 ? "authentication"
          : status === 429 ? "rate_limit" : status === 503 ? "unavailable" : "unknown";
        reportFailure("handshake", reason, undefined, status);
        fail("service-error", getTaskFailureMessage(reason));
      });

      socket.on("error", () => {
        fail("network-interruption", "无法连接百炼语音转写服务，请检查网络后重试。");
      });

      socket.on("close", () => {
        if (!terminal) {
          fail("network-interruption", "百炼语音转写连接意外中断，请重新录制。");
        }
      });
    };

    const accept = (data: RawData, isBinary: boolean) => {
      if (terminal) {
        return;
      }

      if (isBinary) {
        if (!localStarted || finishRequested) {
          fail("audio-format", "本地服务收到的音频顺序不正确，请重新录制。");
          return;
        }
        const chunk = asBuffer(data);
        if (!chunk.byteLength || chunk.byteLength % 2 !== 0 || chunk.byteLength > MAX_AUDIO_CHUNK_BYTES) {
          fail("audio-format", "麦克风音频分片格式不正确，请重新录制。");
          return;
        }

        if (pendingAudioBytes + (upstream?.bufferedAmount ?? 0) + chunk.byteLength > MAX_PENDING_AUDIO_BYTES) { fail("connection-timeout", "音频发送拥塞，已停止本轮；转写不完整，请重新录制。"); return; }
        audioBytes += chunk.byteLength;
        if (upstreamTaskStarted && upstream?.readyState === WebSocket.OPEN) {
          upstream.send(chunk, { binary: true });
          return;
        }
        if (pendingAudioBytes + chunk.byteLength > MAX_PENDING_AUDIO_BYTES) {
          fail("connection-timeout", "转写连接建立过慢，请重新录制。");
          return;
        }
        pendingAudio.push(chunk);
        pendingAudioBytes += chunk.byteLength;
        return;
      }

      let message: { type?: string; format?: string; sampleRate?: number; channels?: number };
      try {
        message = JSON.parse(asBuffer(data).toString("utf8")) as typeof message;
      } catch {
        fail("service-error", "本地转写请求无法读取，请刷新页面后重试。");
        return;
      }

      if (message.type === "start") {
        if (localStarted) {
          fail("service-error", "同一录音不能重复启动转写，请重新开始。");
          return;
        }
        if (message.format !== "pcm" || message.sampleRate !== 16000 || message.channels !== 1) {
          fail("audio-format", "只支持 16 kHz、16 位、单声道 PCM 音频。");
          return;
        }
        localStarted = true;
        startUpstream();
        return;
      }

      if (message.type === "finish") {
        if (!localStarted || finishRequested) {
          fail("service-error", "这次转写没有正确开始或已经结束，请重新录制。");
          return;
        }
        finishRequested = true;
        sendFinishTask();
        return;
      }

      if (message.type === "cancel") {
        terminal = true;
        clearTimers();
        closeUpstream();
        pendingAudio = []; pendingAudioBytes = 0;
        return;
      }

      fail("service-error", "本地转写请求类型不受支持，请刷新页面后重试。");
    };

  return {
    accept,
    cancel() { terminal = true; clearTimers(); pendingAudio = []; pendingAudioBytes = 0; closeUpstream(); },
  };
}
