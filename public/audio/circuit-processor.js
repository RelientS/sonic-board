export function isCompatibleCircuitRuntime(exports, expectedRuntimeVersion) {
  return Number.isInteger(expectedRuntimeVersion)
    && typeof exports?.runtime_version === 'function'
    && exports.runtime_version() === expectedRuntimeVersion;
}

// Guitar signals are mono until a stereo effect widens them, so one circuit
// instance serves both channels while they are identical. A second instance is
// created the first time the channels differ.
function channelsMatch(left, right) {
  if (!right || left === right) return true;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

class SonicCircuitProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { wasmModule, expectedRuntimeVersion, modelIndex, controls = [], switches = [] } = options.processorOptions ?? {};
    this.modelIndex = modelIndex;
    this.controls = controls;
    this.switches = switches;
    this.handles = [];
    this.exports = null;
    this.ready = false;
    try {
      if (!(wasmModule instanceof WebAssembly.Module)) return;
      const exports = new WebAssembly.Instance(wasmModule, {}).exports;
      if (!isCompatibleCircuitRuntime(exports, expectedRuntimeVersion)) return;
      this.exports = exports;
      this.ready = this.addInstance();
    } catch {
      this.ready = false;
    }
    this.port.onmessage = (event) => this.receive(event.data);
  }

  addInstance() {
    const handle = this.exports.create(this.modelIndex, sampleRate);
    if (!handle) return false;
    this.controls.forEach((value, index) => this.exports.set_control(handle, index, value));
    this.switches.forEach((value, index) => this.exports.set_switch(handle, index, value));
    this.handles.push(handle);
    return true;
  }

  receive(message) {
    if (!this.ready || !message) return;
    if (message.type === 'control') {
      this.controls[message.index] = message.value;
      this.handles.forEach((handle) => this.exports.set_control(handle, message.index, message.value));
    } else if (message.type === 'switch') {
      this.switches[message.index] = message.value;
      this.handles.forEach((handle) => this.exports.set_switch(handle, message.index, message.value));
    }
  }

  run(handle, source, destination) {
    const pointer = this.exports.buffer_ptr(handle, source.length);
    new Float32Array(this.exports.memory.buffer, pointer, source.length).set(source);
    if (this.exports.process(handle, source.length) !== 1) return false;
    // process() may grow WASM memory (e.g. the first sub-stepped sample
    // builds its fine-step matrices), which detaches earlier views.
    const buffer = new Float32Array(this.exports.memory.buffer, pointer, source.length);
    for (let index = 0; index < buffer.length; index += 1) {
      const sample = buffer[index];
      if (!Number.isFinite(sample) || Math.abs(sample) > 8) return false;
    }
    destination.set(buffer);
    return true;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output?.length) return true;
    if (!input?.length) {
      output.forEach((channel) => channel.fill(0));
      return true;
    }
    if (!this.ready) {
      output.forEach((channel, index) => channel.set(input[index] ?? input[0]));
      return true;
    }

    const left = input[0];
    const right = input[1];
    const mono = this.handles.length === 1 && channelsMatch(left, right);
    if (!mono && this.handles.length === 1 && !this.addInstance()) {
      this.ready = false;
    }
    let ok = this.ready && this.run(this.handles[0], left, output[0]);
    for (let channel = 1; ok && channel < output.length; channel += 1) {
      if (mono) output[channel].set(output[0]);
      else ok = this.run(this.handles[1], input[channel] ?? left, output[channel]);
    }
    if (!ok) {
      // A diverged circuit falls back to dry signal rather than noise.
      this.ready = false;
      output.forEach((channel, index) => channel.set(input[index] ?? left));
    }
    return true;
  }
}

registerProcessor('sonic-circuit', SonicCircuitProcessor);
