import { readFile } from 'node:fs/promises';

const wasm = await readFile(
  new URL(
    '../target/wasm32-unknown-unknown/release/loop_engine.wasm',
    import.meta.url,
  ),
);
const module = await globalThis.WebAssembly.compile(wasm);
const report = {
  build: process.env.GITHUB_SHA ?? 'working tree',
  wasmBytes: wasm.byteLength,
  rates: [],
};

for (const sampleRate of [8_000, 44_100, 48_000, 192_000]) {
  const measure = (configure) => {
    const { exports } = new globalThis.WebAssembly.Instance(module, {});
    const beforeInitialize = exports.memory.buffer.byteLength;
    if (exports.initialize(sampleRate) !== 1) {
      throw new Error(`WASM rejected sample rate ${sampleRate}`);
    }
    const afterInitialize = exports.memory.buffer.byteLength;
    if (configure) {
      const cutoff = Math.min(20_000, sampleRate * 0.45);
      if (
        exports.set_input_fx(1, cutoff, 0) !== 0 ||
        exports.set_track_fx(0, 1, cutoff, 0) !== 0 ||
        exports.set_track_fx(1, 1, cutoff, 0) !== 0 ||
        exports.set_master_fx(1, cutoff, 0) !== 0
      ) {
        throw new Error(`WASM rejected FX configuration at ${sampleRate} Hz`);
      }
    }
    return {
      beforeInitializeBytes: beforeInitialize,
      afterInitializeBytes: afterInitialize,
      afterConfigurationBytes: exports.memory.buffer.byteLength,
    };
  };
  const baseline = measure(false);
  const fourFilters = measure(true);
  report.rates.push({
    sampleRate,
    baseline,
    fourFilters,
    configuredVsBaselineBytes:
      fourFilters.afterConfigurationBytes - baseline.afterConfigurationBytes,
  });
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
