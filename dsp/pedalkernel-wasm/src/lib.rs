use pedalkernel::compiler::compile_pedal;
use pedalkernel::dsl::parse_pedal_file;
use pedalkernel::PedalProcessor;
use std::cell::RefCell;
use std::f32::consts::PI;

const MODELS: [&str; 13] = [
    include_str!("../models/dyna_comp.pedal"),
    include_str!("../models/blues_driver.pedal"),
    include_str!("../models/proco_rat.pedal"),
    include_str!("../models/big_muff.pedal"),
    include_str!("../models/boss_dm2.pedal"),
    include_str!("../models/memory_man.pedal"),
    include_str!("../models/fuzz_face.pedal"),
    include_str!("../models/boss_ce2.pedal"),
    include_str!("../models/fulltone_ocd.pedal"),
    include_str!("../models/klon_centaur.pedal"),
    include_str!("../models/sd1.pedal"),
    include_str!("../models/tube_screamer.pedal"),
    include_str!("../models/phase90.pedal"),
];

const CONTROLS: [&[&str]; 13] = [
    &["Sensitivity", "Output"],
    &["Gain", "Tone", "Level"],
    &["Distortion", "Filter", "Volume"],
    &["Sustain", "Tone", "Volume"],
    &["Time", "Repeats", "Mix"],
    &["Delay", "Feedback", "Blend"],
    &["Fuzz", "Volume"],
    &["Rate", "Depth"],
    &["Drive", "Tone", "Volume"],
    &["Gain", "Treble", "Output"],
    &["Drive", "Tone", "Level"],
    &["Drive", "Tone", "Level"],
    &["Speed"],
];

// PedalKernel's example circuits use physical component magnitudes and do not
// share a common line-level calibration. These fixed make-up gains were measured
// with a -22 dBFS DI reference and are followed by a bounded analog-style limiter.
const OUTPUT_GAINS: [f32; 13] = [
    6.0,
    8.0,
    1.0,
    30_000.0,
    8.0,
    8.0,
    80.0,
    125.0,
    8.0,
    1.5,
    3.0,
    35.0,
    8_000_000.0,
];

#[derive(Default)]
struct BigMuffRepair {
    previous_input: f32,
    high_passed: f32,
    bass: f32,
    treble_reference: f32,
    output: f32,
}

impl BigMuffRepair {
    fn process(&mut self, input: f32, sample_rate: f32, controls: &[f32; 3]) -> f32 {
        let sustain = controls[0].clamp(0.0, 1.0);
        let tone = controls[1].clamp(0.0, 1.0);
        let volume = controls[2].clamp(0.0, 1.0);
        let high_pass_coefficient = (-2.0 * PI * 42.0 / sample_rate).exp();
        self.high_passed = input - self.previous_input + high_pass_coefficient * self.high_passed;
        self.previous_input = input;

        // Two saturated gain stages mirror the pair of diode-clipped transistor
        // stages while avoiding the full multi-device Newton solve per sample.
        let first = (self.high_passed * (5.0 + sustain * 26.0)).tanh();
        let clipped = (first * (2.1 + sustain * 5.4)).tanh();
        let bass_alpha = 1.0 - (-2.0 * PI * 780.0 / sample_rate).exp();
        let treble_alpha = 1.0 - (-2.0 * PI * 2_200.0 / sample_rate).exp();
        self.bass += bass_alpha * (clipped - self.bass);
        self.treble_reference += treble_alpha * (clipped - self.treble_reference);
        let treble = clipped - self.treble_reference;
        let tone_stack = self.bass * (1.0 - tone) * 1.18 + treble * tone * 1.52 + clipped * 0.11;
        let output_alpha = 1.0 - (-2.0 * PI * 7_200.0 / sample_rate).exp();
        self.output += output_alpha * (tone_stack - self.output);
        self.output * (0.16 + volume * 0.74) * 0.12
    }
}

#[derive(Default)]
struct FuzzFaceRepair {
    previous_input: f32,
    high_passed: f32,
    output: f32,
}

impl FuzzFaceRepair {
    fn process(&mut self, input: f32, sample_rate: f32, controls: &[f32; 3]) -> f32 {
        let fuzz = controls[0].clamp(0.0, 1.0);
        let volume = controls[1].clamp(0.0, 1.0);
        let high_pass_coefficient = (-2.0 * PI * 31.0 / sample_rate).exp();
        self.high_passed = input - self.previous_input + high_pass_coefficient * self.high_passed;
        self.previous_input = input;

        // Germanium Fuzz Face clipping is deliberately asymmetric. The two
        // slopes preserve pick cleanup at low fuzz and the softer negative lobe.
        let drive = 1.6 + fuzz * 19.0;
        let shaped = if self.high_passed >= 0.0 {
            (self.high_passed * drive * 0.82).tanh()
        } else {
            (self.high_passed * drive * 1.16).tanh() * 0.78
        };
        let cutoff = 6_800.0 - fuzz * 2_100.0;
        let output_alpha = 1.0 - (-2.0 * PI * cutoff / sample_rate).exp();
        self.output += output_alpha * (shaped - self.output);
        self.output * (0.18 + volume * 0.82) * 0.16
    }
}

#[derive(Default)]
struct PhaserRepair {
    phase: f32,
    previous_input: [f32; 4],
    previous_output: [f32; 4],
}

impl PhaserRepair {
    fn process(&mut self, input: f32, sample_rate: f32, speed: f32) -> f32 {
        let rate_hz = 0.05 * (200.0_f32).powf(speed.clamp(0.0, 1.0));
        self.phase = (self.phase + rate_hz / sample_rate).fract();
        let lfo = (self.phase * 2.0 * PI).sin();
        let corner_hz = 180.0 * (12.0_f32).powf((lfo + 1.0) * 0.5);
        let tangent = (PI * corner_hz / sample_rate).tan();
        let coefficient = (1.0 - tangent) / (1.0 + tangent);
        let mut wet = input;
        for stage in 0..4 {
            let output = -coefficient * wet
                + self.previous_input[stage]
                + coefficient * self.previous_output[stage];
            self.previous_input[stage] = wet;
            self.previous_output[stage] = output;
            wet = output;
        }
        (input + wet) * 0.5
    }
}

#[derive(Default)]
struct EngineState {
    processor: Option<Box<dyn PedalProcessor>>,
    model_id: Option<usize>,
    buffer: Vec<f32>,
    dc_input: f32,
    dc_output: f32,
    sample_rate: f32,
    controls: [f32; 3],
    big_muff_repair: BigMuffRepair,
    fuzz_face_repair: FuzzFaceRepair,
    phaser_repair: PhaserRepair,
    tone_repair: f32,
}

thread_local! {
    static ENGINE: RefCell<EngineState> = RefCell::new(EngineState::default());
}

#[no_mangle]
pub extern "C" fn runtime_version() -> u32 {
    4
}

#[no_mangle]
pub extern "C" fn init_model(model_id: u32, sample_rate: u32) -> u32 {
    let index = model_id as usize;
    if index >= MODELS.len() || !(8_000..=192_000).contains(&sample_rate) {
        return 0;
    }
    let processor: Option<Box<dyn PedalProcessor>> = if matches!(index, 3 | 6) {
        None
    } else {
        let Ok(definition) = parse_pedal_file(MODELS[index]) else {
            return 0;
        };
        let Ok(processor) = compile_pedal(&definition, sample_rate as f64) else {
            return 0;
        };
        Some(Box::new(processor))
    };
    ENGINE.with(|engine| {
        let mut engine = engine.borrow_mut();
        engine.processor = processor;
        engine.model_id = Some(index);
        engine.dc_input = 0.0;
        engine.dc_output = 0.0;
        engine.sample_rate = sample_rate as f32;
        engine.controls = [0.0; 3];
        engine.big_muff_repair = BigMuffRepair::default();
        engine.fuzz_face_repair = FuzzFaceRepair::default();
        engine.phaser_repair = PhaserRepair::default();
        engine.tone_repair = 0.0;
    });
    1
}

#[no_mangle]
pub extern "C" fn set_control(control_id: u32, value: f32) -> u32 {
    ENGINE.with(|engine| {
        let mut engine = engine.borrow_mut();
        let Some(model_id) = engine.model_id else {
            return 0;
        };
        let Some(label) = CONTROLS[model_id].get(control_id as usize) else {
            return 0;
        };
        let value = value.clamp(0.0, 1.0);
        if let Some(control) = engine.controls.get_mut(control_id as usize) {
            *control = value;
        }
        let Some(processor) = engine.processor.as_mut() else {
            return 0;
        };
        processor.set_control(label, value as f64);
        1
    })
}

#[no_mangle]
pub extern "C" fn resize_buffer(length: u32) -> u32 {
    if length == 0 || length > 1_048_576 {
        return 0;
    }
    ENGINE.with(|engine| engine.borrow_mut().buffer.resize(length as usize, 0.0));
    1
}

#[no_mangle]
pub extern "C" fn buffer_ptr() -> *mut f32 {
    ENGINE.with(|engine| engine.borrow_mut().buffer.as_mut_ptr())
}

#[no_mangle]
pub extern "C" fn process_block(length: u32) -> u32 {
    ENGINE.with(|engine| {
        let mut engine = engine.borrow_mut();
        let EngineState {
            processor,
            model_id,
            buffer,
            dc_input,
            dc_output,
            sample_rate,
            controls,
            big_muff_repair,
            fuzz_face_repair,
            phaser_repair,
            tone_repair,
        } = &mut *engine;
        let Some(model_id) = *model_id else {
            return 0;
        };
        let count = usize::min(length as usize, buffer.len());
        for sample in &mut buffer[..count] {
            let modeled = match model_id {
                3 => big_muff_repair.process(*sample, *sample_rate, controls),
                6 => fuzz_face_repair.process(*sample, *sample_rate, controls),
                _ => {
                    let Some(processor) = processor.as_mut() else {
                        return 0;
                    };
                    processor.process(*sample as f64) as f32 * OUTPUT_GAINS[model_id]
                }
            };
            let high_passed = modeled - *dc_input + 0.995 * *dc_output;
            *dc_input = modeled;
            *dc_output = high_passed;
            let repaired = if model_id == 12 {
                phaser_repair.process(high_passed, *sample_rate, controls[0])
            } else if model_id == 9 {
                // The upstream Centaur netlist's passive treble branch is
                // currently collapsed by the graph compiler. Preserve the WDF
                // output and restore the missing variable low-pass blend.
                *tone_repair += 0.08 * (high_passed - *tone_repair);
                *tone_repair * (1.0 - controls[1]) + high_passed * controls[1]
            } else {
                high_passed
            };
            *sample = repaired / (1.0 + repaired.abs());
        }
        1
    })
}
