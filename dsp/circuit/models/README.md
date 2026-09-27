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
| `*@ota SUBCKT is= n= beta= v0= w=` | CA3080-style OTA for `X` elements with six nodes: `Xname in+ in- out abc v+ v- SUBCKT`. The bias input is a diode (`is`, `n`) to v-, whose current is the tail Iabc; output current Iabc·tanh(vd/2Vt) from two mirrors that fade out within `v0` (knee `w`) of their rail; inputs draw Iabc(1±tanh)/2β. A 1 GΩ leak across the bias input keeps a bias node fed only through a resistor well-conditioned (in the engine and the ngspice deck alike) |
| `*@be ELEMENT...` | Integrate these capacitors with backward Euler (first order; only for poles far above the sample rate) |
| `*@lfo VSRC SHAPE [rate=LABEL] lo= hi= ...` | Internal modulation oscillator driving voltage source VSRC per sample (an extra solver input, no refactorization). Shapes `sine`, `tri` (rate `hz=MIN:MAX`, exponential over the control) and `relax`: an op-amp Schmitt-trigger RC oscillator whose timing capacitor charges toward `vlo`/`vhi` between thresholds `lo`/`hi`, with `c=` `r=` (series) `pot=OHM:TAPER` (resistance falls to 0 at rotation 1) and optional `load=OHM:V`, or a pot-divider integrator (`hzmax=` `r=` fixed `pot=OHM:TAPER`: rate ∝ (r + pot·taper) / (r + pot), as in a triangle generator driven from a rate divider). VSRC's DC value is the starting voltage; `circuit-tool compare` hands ngspice the same waveform as a PWL source |
| `*@bbd VSRC in=NODE stages=N (hz=F \| clk=NODE r= c= vcc= vth= [vf= vmin= tdis= div=]) [cti=] [gain=] [clip=]` | Bucket-brigade delay line (see below). Node `in` is sampled once per clock period and the samples drive voltage source VSRC `N/2` periods later. The clock is fixed (`hz=`) or an MN3101-style RC oscillator whose start voltage follows node `clk` |

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
| `mxr_dynacomp.cir` | MXR Dyna Comp (CA3080) | bubbajfett kicad-guitar-pedals dynacomp board (pad netlist), Network-Direction BOM, ElectroSmash analysis | 2× | 0.06% | 21× |
| `boss_ce2.cir` | Boss CE-2 Chorus (MN3007 + MN3101) | Boss service schematic (hobby-hour), ElectroSmash analysis | 2× | 0.7%* | 19× |

\* CE-2: ngspice cannot run the bucket brigade, so the analog sections are
checked separately with the delay line cut (`compare --node bbdin` for the
input chain, `--bbd F:AMP` driving the BBD output for the reconstruction
filter and mixer, `--node clk` for LFO → Depth → Q4 → clock node). All
sections are ≤ 0.02% in band; the 0.7% is a 6 kHz tone already ~20 dB down
in the reconstruction filter. DC operating point within 0.32 mV.

### Bucket brigade (`*@bbd`)

The delay line is kept in clock-count time, which is how the chip works: the
clock phase `c(t) = ∫ f_clock dt` is accumulated every solver step, the input
node is sampled at every integer count (cubic interpolation between solver
steps, so input content above half the clock aliases as in the chip), and the
output is read at count `c(t) − N/2`. The delay is `N / (2 f_clock)` and any
clock modulation produces the corresponding pitch shift. The output is an
extra solver input column (like `*@lfo`) and the input/clock nodes are
solver output taps, so nothing is refactorized per sample.

Approximations: the output is interpolated between clock samples instead of
the chip's sample-and-hold steps (their images near the clock would alias at
the solver rate and are removed by the pedal's reconstruction filter; the
sin(x)/x droop is < 0.1 dB in band); charge-transfer inefficiency `cti` per
transfer is the clock-rate one-pole `(1 − a)/(1 − a z⁻¹)`, `a = N·cti`, which
matches the cascade's low-frequency roll-off (−0.05 dB at 5 kHz for
`cti=1e-4` at 100 kHz); saturation is a symmetric soft limit at `clip` volts
around the input's DC level (bias correctly trimmed); clock feedthrough, BBD
noise and the output's DC shift are not modelled. The `Rc` clock is the
MN3101 driven as in the CE-2: the timing capacitor restarts at
`max(v(clk) − vf, vmin)` and charges through `r` from `vcc` to `vth`, period
`r c ln((vcc − v0)/(vcc − vth)) + tdis`, divided by `div` for the two-phase
clock. Element checks (`cargo test bbd`): a fixed 100 kHz clock matches an
ideal 5.12 ms delay to 0.0006% NRMSE; an 80–120 kHz swept clock matches the
clock-count delay to 4e-6; the CTI roll-off matches theory to 1e-4 dB.
`circuit-tool chorus` reports the clock/delay range, sideband width and the
energy outside the tonal bands (images, aliasing).

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
./target/release/circuit-tool chorus models/X.cir --controls 1,1 --band 300   # modulation pedals: delay range, sidebands, spurious energy
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
