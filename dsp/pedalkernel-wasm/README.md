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
- `4`: Boss DM-2 Delay
- `5`: Electro-Harmonix Deluxe Memory Man
- `6`: Dallas-Arbiter Fuzz Face
- `7`: Boss CE-2 Chorus
- `8`: Fulltone OCD
- `9`: Klon Centaur
- `10`: Boss SD-1 Super OverDrive
- `11`: Ibanez TS808 Tube Screamer
- `12`: MXR Phase 90

The copied definitions provide upstream circuit-source evidence. Sonic Board
adds browser runtime regressions for finite, bounded and sustained output,
calibrated level, and every exposed control. The wrapper also contains documented
corrections for upstream example circuits that lost steady-state signal or had
collapsed control paths. This is not a physical-pedal fidelity measurement.

All 13 models pass the browser runtime gate and are enabled. Sonic Board does not
publish an 8/10 verified score until a physical-pedal ABX and measurement matrix
has passed.
