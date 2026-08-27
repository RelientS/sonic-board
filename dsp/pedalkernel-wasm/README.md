# Sonic Board PedalKernel WASM

This crate wraps the AGPLv3 PedalKernel circuit runtime for browser use. It is
pinned to upstream commit `0278b397c861b5ebef2e8e38d15ab281b8e669dc`.

The copied `.pedal` circuit definitions remain AGPLv3 and retain their upstream
comments. The generated `public/audio/pedalkernel.wasm` is corresponding object
code for this crate and the pinned PedalKernel source.

Model IDs:

- `0`: MXR Dyna Comp
- `1`: Boss Blues Driver
- `2`: ProCo RAT
- `3`: Electro-Harmonix Big Muff Pi

The copied definitions provide upstream circuit-source evidence. Sonic Board
adds browser runtime regressions for finite, bounded and sustained output plus
control response. This is not a physical-pedal fidelity measurement.

The Dyna Comp and RAT candidates currently pass the runtime gate and are enabled
in the browser. The Blues Driver and Big Muff candidates remain compiled for
diagnosis but are not runtime-enabled because their sustained output gate fails.
Sonic Board does not publish an 8/10 verified score until a physical-pedal ABX
and measurement matrix has passed.
