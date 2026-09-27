import createNamModule from './nam/nam.js';
import { NamWasmModule } from './nam/NamWasmModule.js';

let runtimePromise;

function loadRuntime(sampleRate, wasmModule) {
  if (!runtimePromise) {
    runtimePromise = createNamModule({
      // AudioWorkletGlobalScope does not expose URL; compiled WASM is injected below.
      locateFile: (fileName) => fileName,
      instantiateWasm(imports, receiveInstance) {
        const instance = new WebAssembly.Instance(wasmModule, imports);
        receiveInstance(instance);
        return instance.exports;
      },
    }).then((module) => {
      const runtime = NamWasmModule.fromModule(module);
      runtime.setSampleRate(sampleRate);
      return runtime;
    });
  }
  return runtimePromise;
}

class SonicNamProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.runtime = null;
    this.instances = [];
    this.ready = false;
    this.failed = false;
    this.processErrorReported = false;
    this.port.onmessage = (event) => {
      if (event.data?.type === 'dispose') this.dispose();
      if (event.data?.type === 'reset') this.instances.forEach((instance) => this.runtime?.reset(instance));
    };
    void this.initialize(options.processorOptions?.modelJson, options.processorOptions?.wasmModule);
  }

  async initialize(modelJson, wasmModule) {
    try {
      if (typeof modelJson !== 'string' || !modelJson) throw new Error('Missing local NAM model');
      if (!(wasmModule instanceof WebAssembly.Module)) throw new Error('Missing compiled NAM runtime');
      const runtime = await loadRuntime(sampleRate, wasmModule);
      this.runtime = runtime;
      this.instances = [runtime.createInstance(), runtime.createInstance()];
      if (!this.instances.every((instance) => runtime.loadModel(instance, modelJson))) {
        throw new Error('NAM runtime rejected this model');
      }
      this.ready = true;
      this.port.postMessage({ type: 'model-loaded' });
    } catch (error) {
      this.failed = true;
      this.port.postMessage({ type: 'model-error', message: error instanceof Error ? error.message : String(error) });
    }
  }

  dispose() {
    this.instances.forEach((instance) => {
      try { this.runtime?.destroyInstance(instance); } catch { /* already released */ }
    });
    this.instances = [];
    this.ready = false;
    this.disposed = true;
  }

  process(inputs, outputs) {
    // Returning false lets the browser collect a disposed node.
    if (this.disposed) return false;
    const inputChannels = inputs[0] ?? [];
    const outputChannels = outputs[0] ?? [];
    // Mono input (the usual DI chain): run the model once and copy it, rather
    // than paying for the same network on every output channel.
    if (inputChannels.length === 1 && outputChannels.length > 1) {
      this.render(0, inputChannels[0], outputChannels[0]);
      for (let channel = 1; channel < outputChannels.length; channel += 1) outputChannels[channel].set(outputChannels[0]);
      return true;
    }
    outputChannels.forEach((destination, channel) => this.render(channel, inputChannels[channel] ?? inputChannels[0], destination));
    return true;
  }

  render(channel, source, destination) {
    if (!source) {
      destination.fill(0);
      return;
    }
    if (!this.ready || this.failed) {
      destination.set(source);
      return;
    }
    try {
      this.runtime.process(this.instances[channel % this.instances.length], source, destination);
      if (!destination.every(Number.isFinite)) destination.set(source);
    } catch (error) {
      if (!this.processErrorReported) {
        this.processErrorReported = true;
        this.port.postMessage({ type: 'process-error', message: error instanceof Error ? error.message : String(error) });
      }
      destination.set(source);
    }
  }
}

registerProcessor('sonic-nam', SonicNamProcessor);
