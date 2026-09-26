class Pcm16Downsampler extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.targetSampleRate = options.processorOptions?.targetSampleRate ?? 16000;
    this.phase = 0;
    this.sampleSum = 0;
    this.sampleCount = 0;
    this.reportedFormatError = false;
    this.finished = false;
    this.port.onmessage = event => {
      if (event.data?.type !== "flush" || this.finished) return;
      this.finished = true;
      // Deliver the partial downsampling group before the explicit terminal marker.
      if (this.sampleCount) {
        const value = Math.max(-1, Math.min(1, this.sampleSum / this.sampleCount));
        const pcm = new Int16Array([value < 0 ? Math.round(value * 32768) : Math.round(value * 32767)]);
        this.port.postMessage({ type: "audio", buffer: pcm.buffer }, [pcm.buffer]);
        this.sampleSum = 0; this.sampleCount = 0;
      }
      this.port.postMessage({ type: "flushed" });
    };
  }

  process(inputs) {
    if (this.finished) return false;
    const channels = inputs[0];
    if (!channels?.length || !channels[0]?.length) {
      return true;
    }

    if (sampleRate < this.targetSampleRate) {
      if (!this.reportedFormatError) {
        this.reportedFormatError = true;
        this.port.postMessage({ type: "format-error" });
      }
      return false;
    }

    const frameCount = channels[0].length;
    const output = [];

    for (let frame = 0; frame < frameCount; frame += 1) {
      let monoSample = 0;
      for (let channel = 0; channel < channels.length; channel += 1) {
        monoSample += channels[channel][frame] ?? 0;
      }
      monoSample /= channels.length;

      this.sampleSum += monoSample;
      this.sampleCount += 1;
      this.phase += this.targetSampleRate;

      if (this.phase >= sampleRate) {
        const averagedSample = this.sampleSum / this.sampleCount;
        const clamped = Math.max(-1, Math.min(1, averagedSample));
        output.push(clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767));
        this.phase -= sampleRate;
        this.sampleSum = 0;
        this.sampleCount = 0;
      }
    }

    if (output.length) {
      const pcm = new Int16Array(output);
      this.port.postMessage({ type: "audio", buffer: pcm.buffer }, [pcm.buffer]);
    }

    return true;
  }
}

registerProcessor("pcm16-downsampler", Pcm16Downsampler);
