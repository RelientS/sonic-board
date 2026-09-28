# Third-party notices

## PedalKernel

Sonic Board includes and compiles parts of [PedalKernel](https://github.com/ajmwagar/pedalkernel) at commit `0278b397c861b5ebef2e8e38d15ab281b8e669dc`.

Copied circuit definitions:

- `examples/pedals/compressor/dyna_comp.pedal`
- `examples/pedals/overdrive/blues_driver.pedal`
- `examples/pedals/distortion/proco_rat.pedal`
- `examples/pedals/fuzz/big_muff.pedal`
- `examples/pedals/delay/boss_dm2.pedal`
- `examples/pedals/delay/memory_man.pedal`
- `examples/pedals/fuzz/fuzz_face.pedal`
- `examples/pedals/modulation/boss_ce2.pedal`
- `examples/pedals/overdrive/fulltone_ocd.pedal`
- `examples/pedals/overdrive/klon_centaur.pedal`
- `examples/pedals/overdrive/sd1.pedal`
- `examples/pedals/overdrive/tube_screamer.pedal`
- `examples/pedals/phaser/phase90.pedal`

The copies include clearly commented Sonic Board corrections for browser runtime
stability, control binding, and output calibration. Corresponding source is kept
next to the wrapper and generated WebAssembly.

The PedalKernel runtime, copied circuit definitions, and the generated `public/audio/pedalkernel.wasm` are governed by the pinned upstream license in `THIRD_PARTY_LICENSES/PedalKernel-LICENSE.txt`. That license includes an additional condition under AGPLv3 Section 7 for incorporation into certain hardware products. Review it before hardware or commercial-device distribution.

The corresponding Sonic Board wrapper source is in `dsp/pedalkernel-wasm`. Rebuild it with `npm run build:dsp`.

## Circuit model sources

The netlists in `dsp/circuit/models` are original Sonic Board work, written
from published schematics and build documents of the referenced pedals. Each
file cites its sources in its header; the main references are Kit Rae's Big
Muff Page, ElectroSmash circuit analyses, Beavis Audio, tagboardeffects, Aion
FX and PedalPCB build documentation, gaussmarkov, and Boss service schematics
as reproduced on hobby-hour.com and schematicheaven.net. Transistor and diode
SPICE parameters come from common vendor and LTspice libraries as noted.

## FreePats Direct DI

The fixed clean electric-guitar samples under `public/audio/guitars` are derived from the [FreePats Clean Electric Guitar Direct DI](https://freepats.zenvoid.org/ElectricGuitar/clean-electric-guitar.html) collection and are distributed under CC0 as stated by the source project.

## Geist fonts

`public/fonts/geist-*.woff2` are the latin and latin-ext subsets of Geist and
Geist Mono by Vercel, distributed under the SIL Open Font License 1.1.

## Trademarks

Product and manufacturer names are used only to identify the hardware or studio unit used as a tonal reference. Sonic Board is not affiliated with or endorsed by those manufacturers.
