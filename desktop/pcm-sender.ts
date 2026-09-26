import { MAX_PCM_PACKET_BYTES, MAX_PCM_QUEUE_BYTES, type PcmPacket } from "./shared";

// One outstanding IPC invocation. Both unsent and in-flight bytes count toward the bound.
export class PcmSender {
  private queue: ArrayBuffer[] = [];
  private buffered: Uint8Array[] = [];
  private bufferedBytes = 0;
  private bytes = 0;
  private sending = false;
  private error: Error | null = null;
  private sequence = 0;
  private waiters: { resolve: (sequence: number) => void; reject: (error: Error) => void }[] = [];
  constructor(private sessionId: number, private roundId: number, private deliver: (packet: PcmPacket) => Promise<boolean>, private failure: () => void, private limit = MAX_PCM_QUEUE_BYTES, private timeoutMs = 6000) {}
  push(buffer: ArrayBuffer) {
    if (this.error) return;
    if (!(buffer instanceof ArrayBuffer) || !buffer.byteLength || buffer.byteLength % 2 || buffer.byteLength > MAX_PCM_PACKET_BYTES || this.bytes + buffer.byteLength > this.limit) { this.fail(); return; }
    this.bytes += buffer.byteLength; this.buffered.push(new Uint8Array(buffer)); this.bufferedBytes += buffer.byteLength;
    if (this.bufferedBytes >= 3200) this.flush();
  }
  private flush() {
    if (!this.bufferedBytes || this.error) return;
    const packet = new Uint8Array(this.bufferedBytes); let offset = 0;
    for (const chunk of this.buffered) { packet.set(chunk, offset); offset += chunk.length; }
    this.buffered = []; this.bufferedBytes = 0;
    for (let start = 0; start < packet.byteLength; start += MAX_PCM_PACKET_BYTES) this.queue.push(packet.buffer.slice(start, start + MAX_PCM_PACKET_BYTES));
    void this.pump();
  }
  private async pump() {
    if (this.sending || this.error) return;
    this.sending = true;
    try {
      while (this.queue.length && !this.error) {
        const bytes = this.queue.shift()!;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const ack = await Promise.race([
            this.deliver({ sessionId: this.sessionId, roundId: this.roundId, sequence: this.sequence, bytes }),
            new Promise<boolean>((_, reject) => { timer = setTimeout(() => reject(new Error("pcm_timeout")), this.timeoutMs); }),
          ]);
          if (this.error) return;
          if (!ack) { this.fail(); return; }
          this.sequence++; this.bytes -= bytes.byteLength;
        } finally { clearTimeout(timer); }
      }
    } catch { this.fail(); }
    finally {
      this.sending = false;
      if (!this.error && !this.queue.length && !this.bufferedBytes) { const waiters = this.waiters.splice(0); waiters.forEach(w => w.resolve(this.sequence - 1)); }
    }
  }
  async drain() {
    if (this.error) throw this.error;
    this.flush();
    if (!this.sending && !this.queue.length) return this.sequence - 1;
    return new Promise<number>((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
  cancel() { this.fail(false); }
  private fail(notify = true) {
    if (this.error) return;
    this.error = new Error("pcm_delivery_failed"); this.queue = []; this.buffered = []; this.bufferedBytes = 0; this.bytes = 0;
    this.waiters.splice(0).forEach(w => w.reject(this.error!));
    if (notify) this.failure();
  }
}
