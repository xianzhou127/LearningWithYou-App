export type AsrErrorCode =
  | "missing-api-key"
  | "microphone-denied"
  | "empty-audio"
  | "audio-format"
  | "connection-timeout"
  | "network-interruption"
  | "service-error"
  | "cancelled";

export class AsrClientError extends Error {
  readonly code: AsrErrorCode;

  constructor(code: AsrErrorCode, message: string) {
    super(message);
    this.name = "AsrClientError";
    this.code = code;
  }
}
