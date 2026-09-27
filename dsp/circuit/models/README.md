# Circuit models

Each `.cir` file is a plain SPICE deck that runs unchanged in ngspice (the
offline reference) and in the realtime DK solver. Realtime metadata lives in
`*@` comment directives:

| Directive | Meaning |
| --- | --- |
| `*@name TEXT` | Display name |
| `*@input VSRC` | Voltage source driven by audio (1.0 digital = 1 V) |
| `*@output NODE [GAIN]` | Output node and digital make-up gain |
| `*@oversample N` | Oversampling factor for the nonlinear core (1-16) |
| `*@pot NAME RA RB TOTAL TAPER` | Pot as two resistor elements: RA = lug 1 to wiper, RB = wiper to lug 3 (`-` if unused). Rotation 1.0 puts the wiper at lug 3. Taper `lin`, `log` (A, 10% at half) or `revlog` (C) |
| `*@control LABEL POT [POT...] [default=x] [invert]` | User knob driving one or more pots (dual-gang) |
| `*@switch LABEL ELEMENT OFF ON [default=0]` | Toggle that sets a resistor value |
| `*@opamp SUBCKT gbw= slew= aol= vlo= vhi= rout=` | Op-amp macro for `X` elements: `Xname in+ in- out SUBCKT`. `vlo`/`vhi` are absolute output swing limits in volts |
| `*@be ELEMENT...` | Integrate these capacitors with backward Euler (first order; only for poles far above the sample rate) |
| `*@lfo VSRC SHAPE [rate=LABEL] lo= hi= ...` | Internal modulation oscillator driving voltage source VSRC per sample (an extra solver input, no refactorization). Shapes `sine`, `tri` (rate `hz=MIN:MAX`, exponential over the control) and `relax`: an op-amp Schmitt-trigger RC oscillator whose timing capacitor charges toward `vlo`/`vhi` between thresholds `lo`/`hi`, with `c=` `r=` (series) `pot=OHM:TAPER` (resistance falls to 0 at rotation 1) and optional `load=OHM:V`. VSRC's DC value is the starting voltage; `circuit-tool compare` hands ngspice the same waveform as a PWL source |

Supported elements: `R C L V D Q J E X`. Models: `D(IS N RS)`, `NPN/PNP(IS BF BR NF VAF RB RE RC)`,
`NJF/PJF(VTO BETA LAMBDA IS)`. Junction capacitances are not modelled; add
explicit capacitors when they matter. Every bundled model puts a guitar pickup
source impedance (6.5 kΩ + 2.3 H) in front of the input and a 1 MΩ amp load
on the output.

## Bundled models

NRMSE is the worst normalized RMS error against ngspice over the validation
matrix (7 knob sets × 3 test signals at 192 kHz). It measures how faithfully
the realtime solver follows the schematic, not how close the model is to a
physical unit. Realtime factors are native Rust on an Apple M4 at the chosen
oversampling; the browser (WASM) build runs at roughly 60-70% of that.

| File | Pedal | Main source | Oversample | NRMSE | Realtime |
| --- | --- | --- | --- | --- | --- |
| `rams_head_muff.cir` | EHX Big Muff Pi Ram's Head | Kit Rae, V2 Violet 1973 #4 | 4× | 0.52% | 13× |
| `opamp_big_muff.cir` | EHX Op-Amp Big Muff | Aion FX Corvus docs, tagboardeffects | 4× | 0.67% | 14× |
| `proco_rat2.cir` | ProCo RAT 2 | Beavis Audio RAT II schematic | 4× | 0.29% | 18× |
| `boss_ds1.cir` | Boss DS-1 | Boss DS-1A service schematic | 4× | 0.56% | 11× |
| `boss_bd2.cir` | Boss BD-2 | Boss MT board 70567645 service schematic | 2× | 1.12% | 8.5× |
| `klon_centaur.cir` | Klon Centaur (Studio Daydream KCM-OD) | ElectroSmash Klon analysis | 2× | 0.05% | 25× |
| `fuzz_face.cir` | Dallas-Arbiter Fuzz Face (germanium AC128) | ElectroSmash Fuzz Face analysis | 4× | 0.13% | 25× |
| `ibanez_ts808.cir` | Ibanez TS808 Tube Screamer | ElectroSmash TS analysis, Geofex tstech | 4× | 0.21% | 15× |
| `boss_sd1.cir` | Boss SD-1 Super OverDrive | Boss service schematic (hobby-hour) | 4× | 0.06% | 14.5× |
| `fulltone_ocd.cir` | Fulltone OCD ("version 3" trace) | tuemmueh trace via PCB Guitar Mania TOC doc | 4× | 0.08% | 22× |
| `mxr_phase90.cir` | MXR Phase 90 (script logo; block-logo feedback on a switch) | General Guitar Gadgets schematic 2015-06-30, ElectroSmash analysis | 2× | 0.04% | 14× |

Each file's header lists its sources, cross-checks and uncertain values
(transistor substitutes, unpublished part choices, omitted switching).

## Validation

```bash
cargo build --release
scripts/validate.sh                                           # full matrix, all models
./target/release/circuit-tool op models/X.cir                 # DC operating point vs ngspice
./target/release/circuit-tool compare models/X.cir --controls 0.5,0.5,0.5 --signal 440:0.3
./target/release/circuit-tool alias models/X.cir --os 4       # non-harmonic energy
./target/release/circuit-tool bench models/X.cir              # realtime factor
```

## Comparing with a real pedal

`examples/capture.rs` measures a model against a reamped hardware unit:

```bash
cargo run --release --example capture -- signal capture-signal.wav --guitars ../../public/audio/guitars/fender-direct-picked
# Reamp capture-signal.wav through the pedal at known knob positions and record the output.
cargo run --release --example capture -- compare models/X.cir capture-signal.wav recorded.wav --controls 0.6,0.5,0.7
```

It aligns the recording, fits the unknown reamp level (the circuits are
nonlinear, so the level matters) and the recording gain, then reports the
error-to-signal ratio per segment plus a third-octave level difference.
