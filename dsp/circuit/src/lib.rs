//! Sonic Board circuit engine: SPICE netlists solved in realtime with the
//! nodal DK method, validated offline against ngspice.

pub mod devices;
pub mod lfo;
pub mod linalg;
pub mod models;
pub mod netlist;
pub mod oversample;
pub mod pedal;
pub mod solver;

#[cfg(target_arch = "wasm32")]
mod wasm;
