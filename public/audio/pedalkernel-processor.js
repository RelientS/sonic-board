export function isCompatiblePedalKernelRuntime(exports, expectedRuntimeVersion) {
  return Number.isInteger(expectedRuntimeVersion)
    && typeof exports?.runtime_version === 'function'
    && exports.runtime_version() === expectedRuntimeVersion;
}

class SonicPedalKernelProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { wasmModule, expectedRuntimeVersion, modelId, controls = [] } = options.processorOptions ?? {};
    this.engines = [];
    this.ready = wasmModule instanceof WebAssembly.Module;
    if (!this.ready) return;

    try {
      for (let channel = 0; channel < 2; channel += 1) {
        const instance = new WebAssembly.Instance(wasmModule, {});
        const exports = instance.exports;
        if (!isCompatiblePedalKernelRuntime(exports, expectedRuntimeVersion)) {
          this.ready = false;
          return;
        }
        if (exports.init_model(modelId, sampleRate) !== 1 || exports.resize_buffer(128) !== 1) {
          this.ready = false;
          return;
        }
        controls.forEach((value, controlId) => exports.set_control(controlId, value));
        this.engines.push({ exports, buffer: null });
      }
    } catch {
      this.ready = false;
    }
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input?.length || !output?.length) return true;

    for (let channel = 0; channel < output.length; channel += 1) {
      const source = input[channel] ?? input[0];
      const destination = output[channel];
      if (!source || !destination) continue;
      const engine = this.engines[channel] ?? this.engines[0];
      if (!this.ready || !engine) {
        destination.set(source);
        continue;
      }

      const { exports } = engine;
      if (exports.resize_buffer(source.length) !== 1) {
        destination.set(source);
        continue;
      }
      const buffer = new Float32Array(exports.memory.buffer, exports.buffer_ptr(), source.length);
      buffer.set(source);
      if (exports.process_block(source.length) !== 1) {
        destination.set(source);
        continue;
      }
      let safe = true;
      for (let index = 0; index < buffer.length; index += 1) {
        if (!Number.isFinite(buffer[index]) || Math.abs(buffer[index]) > 8) {
          safe = false;
          break;
        }
      }
      if (!safe) {
        this.ready = false;
        destination.set(source);
        continue;
      }
      destination.set(buffer);
    }
    return true;
  }
}

registerProcessor('sonic-pedalkernel', SonicPedalKernelProcessor);
