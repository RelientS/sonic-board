//! A circuit netlist wrapped as an audio effect: controls, oversampling and
//! level calibration around the DK solver.

use crate::lfo::LfoState;
use crate::netlist::Netlist;
use crate::oversample::Oversampler;
use crate::solver::{Circuit, Solver};
use std::collections::HashMap;

/// Digital full scale maps to this many volts at the pedal input. Clean DI
/// guitar peaks of -6 dBFS therefore arrive as ~0.5 V, a strong humbucker hit.
pub const INPUT_VOLTS_PER_UNIT: f64 = 1.0;

pub struct Pedal {
    pub netlist: Netlist,
    solver: Solver,
    oversampler: Oversampler,
    controls: Vec<f64>,
    switches: Vec<f64>,
    dirty: bool,
    /// Resistor values last handed to the solver: knobs that only drive an
    /// LFO leave them unchanged and skip the matrix rebuild.
    applied: HashMap<String, f64>,
    /// Internal oscillators with the control index setting their rate.
    lfos: Vec<(LfoState, Option<usize>)>,
    dt: f64,
    dc_x: f64,
    dc_y: f64,
    dc_r: f64,
    buf: Vec<f64>,
}

fn overrides(net: &Netlist, controls: &[f64], switches: &[f64]) -> HashMap<String, f64> {
    net.pot_values(controls)
        .into_iter()
        .chain(net.switch_values(switches))
        .map(|(k, v)| (k.to_ascii_lowercase(), v))
        .collect()
}

pub fn be_elements(source: &str) -> Vec<String> {
    source
        .lines()
        .filter_map(|l| l.trim().strip_prefix("*@be"))
        .flat_map(|rest| rest.split_whitespace().map(str::to_string).collect::<Vec<_>>())
        .collect()
}

impl Pedal {
    pub fn new(source: &str, sample_rate: f64) -> Result<Pedal, String> {
        let netlist = Netlist::parse(source)?;
        Self::with_netlist(netlist, &be_elements(source), sample_rate, None)
    }

    pub fn with_netlist(
        netlist: Netlist,
        be: &[String],
        sample_rate: f64,
        oversample: Option<usize>,
    ) -> Result<Pedal, String> {
        let circuit = Circuit::build(&netlist, be)?;
        let factor = oversample.unwrap_or(netlist.oversample).max(1);
        let controls: Vec<f64> = netlist.controls.iter().map(|c| c.default).collect();
        let switches: Vec<f64> = netlist.switches.iter().map(|s| s.default).collect();
        let applied = overrides(&netlist, &controls, &switches);
        let lfos = netlist
            .lfos
            .iter()
            .enumerate()
            .map(|(k, spec)| {
                let control = spec.control.as_ref().and_then(|l| netlist.controls.iter().position(|c| &c.label == l));
                let position = control.map(|i| controls[i]).unwrap_or(0.5);
                (LfoState::new(spec.clone(), circuit.aux_initial[k], position), control)
            })
            .collect();
        let solver = Solver::new(circuit, sample_rate * factor as f64, applied.clone())?;
        let mut pedal = Pedal {
            solver,
            oversampler: Oversampler::new(factor),
            controls,
            switches,
            dirty: false,
            applied,
            lfos,
            dt: 1.0 / (sample_rate * factor as f64),
            dc_x: 0.0,
            dc_y: 0.0,
            dc_r: (-2.0 * std::f64::consts::PI * 8.0 / sample_rate).exp(),
            buf: vec![0.0; factor],
            netlist,
        };
        pedal.settle();
        Ok(pedal)
    }

    /// Let coupling capacitors settle after the DC solve.
    fn settle(&mut self) {
        for _ in 0..256 {
            self.process_sample(0.0);
        }
        self.dc_x = 0.0;
        self.dc_y = 0.0;
    }

    pub fn control_count(&self) -> usize {
        self.controls.len()
    }

    pub fn switch_count(&self) -> usize {
        self.switches.len()
    }

    pub fn set_control(&mut self, index: usize, value: f64) -> bool {
        match self.controls.get_mut(index) {
            Some(c) => {
                let v = value.clamp(0.0, 1.0);
                if *c != v {
                    *c = v;
                    self.dirty = true;
                }
                true
            }
            None => false,
        }
    }

    pub fn set_switch(&mut self, index: usize, value: f64) -> bool {
        match self.switches.get_mut(index) {
            Some(s) => {
                if *s != value {
                    *s = value;
                    self.dirty = true;
                }
                true
            }
            None => false,
        }
    }

    /// Apply pending knob changes (called once per block).
    pub fn commit(&mut self) {
        if self.dirty {
            self.dirty = false;
            for (lfo, control) in &mut self.lfos {
                if let Some(i) = *control {
                    lfo.set_position(self.controls[i]);
                }
            }
            let o = overrides(&self.netlist, &self.controls, &self.switches);
            if o != self.applied {
                // A singular matrix can only come from a broken netlist; keep
                // the previous matrices in that case.
                if self.solver.set_overrides(o.clone()).is_ok() {
                    self.applied = o;
                }
            }
        }
    }

    /// Raw output node voltage at the oversampled rate for one base sample.
    #[inline]
    pub fn process_sample(&mut self, x: f64) -> f64 {
        let factor = self.oversampler.factor();
        let mut up = [0.0f64; 16];
        self.oversampler.up(x * INPUT_VOLTS_PER_UNIT, &mut up[..factor]);
        for k in 0..factor {
            for (i, (lfo, _)) in self.lfos.iter_mut().enumerate() {
                self.solver.set_aux(i, lfo.next(self.dt));
            }
            self.buf[k] = self.solver.step(up[k]);
        }
        let volts = self.oversampler.down(&self.buf);
        let y = volts * self.netlist.output_gain;
        // Gentle DC blocker; real pedals couple the output through a capacitor.
        let out = y - self.dc_x + self.dc_r * self.dc_y;
        self.dc_x = y;
        self.dc_y = out;
        out
    }

    pub fn process(&mut self, buffer: &mut [f32]) {
        self.commit();
        for s in buffer.iter_mut() {
            let y = self.process_sample(*s as f64);
            *s = if y.is_finite() { y as f32 } else { 0.0 };
        }
    }

    pub fn stats(&self) -> (u64, u64, u64) {
        (self.solver.samples, self.solver.iterations, self.solver.failures)
    }

    pub fn refactors(&self) -> u64 {
        self.solver.refactors()
    }

    /// Current LFO rates in Hz (diagnostics).
    pub fn lfo_frequencies(&self) -> Vec<f64> {
        self.lfos.iter().map(|(l, _)| l.frequency()).collect()
    }

    pub fn latency(&self) -> f64 {
        self.oversampler.latency()
    }
}
