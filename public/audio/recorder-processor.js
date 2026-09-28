// Records the first input channel (the dry guitar) and streams it to the main
// thread in chunks, with a peak level per chunk for the meter. Messages in:
// {type:'start'}, {type:'stop'}, {type:'dispose'}. Messages out:
// {type:'chunk', samples: Float32Array, peak}, {type:'level', peak} (while not
// recording, for the meter), {type:'stopped', reason: 'user' | 'full'}.

const CHUNK = 4096;

class SonicRecorderProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.maxSamples = Math.max(CHUNK, Math.floor(options.processorOptions?.maxSamples ?? sampleRate * 60));
    this.recording = false;
    this.disposed = false;
    this.recorded = 0;
    this.buffer = new Float32Array(CHUNK);
    this.filled = 0;
    this.peak = 0;
    this.levelFrames = 0;
    this.port.onmessage = (event) => {
      const type = event.data?.type;
      if (type === 'start') {
        this.recording = true;
        this.recorded = 0;
        this.filled = 0;
        this.peak = 0;
      } else if (type === 'stop') {
        this.finish('user');
      } else if (type === 'dispose') {
        this.recording = false;
        this.disposed = true;
      }
    };
  }

  flush() {
    if (this.filled === 0) return;
    const samples = this.buffer.slice(0, this.filled);
    this.port.postMessage({ type: 'chunk', samples, peak: this.peak }, [samples.buffer]);
    this.filled = 0;
    this.peak = 0;
  }

  finish(reason) {
    if (!this.recording) return;
    this.flush();
    this.recording = false;
    this.port.postMessage({ type: 'stopped', reason });
  }

  process(inputs, outputs) {
    if (this.disposed) return false;
    const input = inputs[0]?.[0];
    for (const channel of outputs[0] ?? []) channel.fill(0);
    if (!input) return true;
    if (!this.recording) {
      // Metering only: report the peak about 20 times a second.
      for (let i = 0; i < input.length; i += 1) this.peak = Math.max(this.peak, Math.abs(input[i]));
      this.levelFrames += input.length;
      if (this.levelFrames >= sampleRate / 20) {
        this.port.postMessage({ type: 'level', peak: this.peak });
        this.levelFrames = 0;
        this.peak = 0;
      }
      return true;
    }
    for (let i = 0; i < input.length; i += 1) {
      if (this.recorded >= this.maxSamples) {
        this.finish('full');
        return true;
      }
      const value = input[i];
      this.buffer[this.filled] = value;
      this.filled += 1;
      this.recorded += 1;
      const magnitude = Math.abs(value);
      if (magnitude > this.peak) this.peak = magnitude;
      if (this.filled === CHUNK) this.flush();
    }
    return true;
  }
}

registerProcessor('sonic-recorder', SonicRecorderProcessor);
