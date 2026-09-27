//! Browser ABI. Several pedal instances may live in one module; each is
//! addressed by a handle. Audio moves through a per-instance f32 buffer.

use crate::models::MODELS;
use crate::netlist::Netlist;
use crate::pedal::Pedal;
use std::cell::RefCell;

struct Slot {
    pedal: Pedal,
    buffer: Vec<f32>,
}

thread_local! {
    static SLOTS: RefCell<Vec<Option<Slot>>> = const { RefCell::new(Vec::new()) };
    static INFO: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

/// Bumped whenever the ABI or any circuit changes, for cache busting.
#[no_mangle]
pub extern "C" fn runtime_version() -> u32 {
    5
}

#[no_mangle]
pub extern "C" fn model_count() -> u32 {
    MODELS.len() as u32
}

fn escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// JSON description of a model: id, name, controls, switches, oversampling.
/// Returns the byte length; read it from `info_ptr()`.
#[no_mangle]
pub extern "C" fn model_info(model: u32) -> u32 {
    let Some(m) = MODELS.get(model as usize) else { return 0 };
    let Ok(net) = Netlist::parse(m.source) else { return 0 };
    let controls: Vec<String> = net
        .controls
        .iter()
        .map(|c| format!("{{\"label\":\"{}\",\"default\":{}}}", escape(&c.label), c.default))
        .collect();
    let switches: Vec<String> = net
        .switches
        .iter()
        .map(|s| format!("{{\"label\":\"{}\",\"default\":{}}}", escape(&s.label), s.default))
        .collect();
    let json = format!(
        "{{\"id\":\"{}\",\"name\":\"{}\",\"oversample\":{},\"controls\":[{}],\"switches\":[{}]}}",
        m.id,
        escape(&net.name),
        net.oversample,
        controls.join(","),
        switches.join(",")
    );
    INFO.with(|info| {
        let mut info = info.borrow_mut();
        info.clear();
        info.extend_from_slice(json.as_bytes());
        info.len() as u32
    })
}

#[no_mangle]
pub extern "C" fn info_ptr() -> *const u8 {
    INFO.with(|info| info.borrow().as_ptr())
}

/// Create a pedal; returns a handle (>0) or 0 on failure.
#[no_mangle]
pub extern "C" fn create(model: u32, sample_rate: u32) -> u32 {
    if !(8_000..=192_000).contains(&sample_rate) {
        return 0;
    }
    let Some(m) = MODELS.get(model as usize) else { return 0 };
    let Ok(pedal) = Pedal::new(m.source, sample_rate as f64) else { return 0 };
    SLOTS.with(|slots| {
        let mut slots = slots.borrow_mut();
        let slot = Some(Slot { pedal, buffer: vec![0.0; 128] });
        if let Some(i) = slots.iter().position(Option::is_none) {
            slots[i] = slot;
            (i + 1) as u32
        } else {
            slots.push(slot);
            slots.len() as u32
        }
    })
}

#[no_mangle]
pub extern "C" fn destroy(handle: u32) {
    SLOTS.with(|slots| {
        if let Some(slot) = slots.borrow_mut().get_mut((handle as usize).wrapping_sub(1)) {
            *slot = None;
        }
    });
}

fn with_slot<R>(handle: u32, f: impl FnOnce(&mut Slot) -> R) -> Option<R> {
    SLOTS.with(|slots| {
        slots
            .borrow_mut()
            .get_mut((handle as usize).wrapping_sub(1))
            .and_then(Option::as_mut)
            .map(f)
    })
}

#[no_mangle]
pub extern "C" fn set_control(handle: u32, index: u32, value: f32) -> u32 {
    with_slot(handle, |s| s.pedal.set_control(index as usize, value as f64) as u32).unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn set_switch(handle: u32, index: u32, value: f32) -> u32 {
    with_slot(handle, |s| s.pedal.set_switch(index as usize, value as f64) as u32).unwrap_or(0)
}

/// Pointer to the instance's audio buffer, valid until the next `resize`.
#[no_mangle]
pub extern "C" fn buffer_ptr(handle: u32, length: u32) -> *mut f32 {
    with_slot(handle, |s| {
        let length = (length as usize).clamp(1, 16_384);
        if s.buffer.len() < length {
            s.buffer.resize(length, 0.0);
        }
        s.buffer.as_mut_ptr()
    })
    .unwrap_or(std::ptr::null_mut())
}

/// Process `length` samples in place. Returns 1 on success.
#[no_mangle]
pub extern "C" fn process(handle: u32, length: u32) -> u32 {
    with_slot(handle, |s| {
        let n = (length as usize).min(s.buffer.len());
        let Slot { pedal, buffer } = s;
        pedal.process(&mut buffer[..n]);
        1
    })
    .unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn latency(handle: u32) -> f32 {
    with_slot(handle, |s| s.pedal.latency() as f32).unwrap_or(0.0)
}

/// Newton failures since creation, for runtime health checks.
#[no_mangle]
pub extern "C" fn failures(handle: u32) -> u32 {
    with_slot(handle, |s| s.pedal.stats().2 as u32).unwrap_or(0)
}
