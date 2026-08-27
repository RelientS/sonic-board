use pedalkernel::compiler::compile_pedal;
use pedalkernel::dsl::parse_pedal_file;
use pedalkernel::PedalProcessor;
use std::cell::RefCell;

const MODELS: [&str; 4] = [
    include_str!("../models/dyna_comp.pedal"),
    include_str!("../models/blues_driver.pedal"),
    include_str!("../models/proco_rat.pedal"),
    include_str!("../models/big_muff.pedal"),
];

const CONTROLS: [&[&str]; 4] = [
    &["Sensitivity", "Output"],
    &["Gain", "Tone", "Level"],
    &["Distortion", "Filter", "Volume"],
    &["Sustain", "Tone", "Volume"],
];

#[derive(Default)]
struct EngineState {
    processor: Option<Box<dyn PedalProcessor>>,
    model_id: Option<usize>,
    buffer: Vec<f32>,
}

thread_local! {
    static ENGINE: RefCell<EngineState> = RefCell::new(EngineState::default());
}

#[no_mangle]
pub extern "C" fn init_model(model_id: u32, sample_rate: u32) -> u32 {
    let index = model_id as usize;
    if index >= MODELS.len() || !(8_000..=192_000).contains(&sample_rate) {
        return 0;
    }
    let Ok(definition) = parse_pedal_file(MODELS[index]) else {
        return 0;
    };
    let Ok(processor) = compile_pedal(&definition, sample_rate as f64) else {
        return 0;
    };
    ENGINE.with(|engine| {
        let mut engine = engine.borrow_mut();
        engine.processor = Some(Box::new(processor));
        engine.model_id = Some(index);
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
        let Some(processor) = engine.processor.as_mut() else {
            return 0;
        };
        processor.set_control(label, value.clamp(0.0, 1.0) as f64);
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
        let EngineState { processor, buffer, .. } = &mut *engine;
        let Some(processor) = processor.as_mut() else {
            return 0;
        };
        let count = usize::min(length as usize, buffer.len());
        for sample in &mut buffer[..count] {
            *sample = processor.process(*sample as f64) as f32;
        }
        1
    })
}
