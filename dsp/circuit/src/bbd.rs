//! Bucket-brigade delay lines (`*@bbd`), advanced once per solver step.
//!
//! A BBD samples its input once per clock period and hands every sample
//! along `stages` capacitors, two per period, so it leaves `stages / 2`
//! periods later. The model keeps that clock-count view exactly: it
//! accumulates the clock phase `c(t) = ∫ f_clock dt`, stores the input
//! sampled at every integer count (interpolated between solver steps), and
//! reads the output at count `c(t) - stages / 2`. The delay therefore follows
//! the modulated clock like the real chip, including the pitch shift of a
//! changing delay.
//!
//! Approximations (documented in dsp/circuit/models/README.md):
//! - the output is read with cubic interpolation between clock samples
//!   instead of the chip's sample-and-hold steps. The steps' images sit near
//!   the clock frequency (~100 kHz), would alias at the solver rate, and are
//!   removed by the pedal's reconstruction filter anyway; their sin(x)/x
//!   droop is under 0.1 dB in the audio band at these clock rates;
//! - charge-transfer inefficiency (a fraction `cti` of each charge is left
//!   behind at every transfer) is the one-pole low-pass `(1 - a) / (1 - a z⁻¹)`
//!   at the clock rate with `a = stages · cti`, which matches the cascade's
//!   low-frequency roll-off and extra delay;
//! - saturation is a symmetric soft limit at `clip` volts around the input's
//!   DC level (a correctly trimmed bias); clock feedthrough and noise are not
//!   modelled.

use crate::netlist::{Bbd, BbdClock};

/// Input history kept for interpolation (solver steps).
const HISTORY: usize = 4;

#[derive(Clone, Debug)]
pub struct BbdState {
    pub spec: Bbd,
    /// Solver aux column driven by the output, and taps for input / clock.
    pub aux: usize,
    pub tap_in: usize,
    pub tap_clock: Option<usize>,
    ring: Vec<f64>,
    mask: usize,
    /// Clock count at the end of the last solver step and the clock
    /// frequency used for the next one.
    count: f64,
    freq: f64,
    /// Input voltages and clock counts at the last solver steps (oldest first).
    xs: [f64; HISTORY],
    cs: [f64; HISTORY],
    /// Next clock sample to write.
    next: i64,
    /// DC level of the input (the reference for saturation).
    dc: f64,
    lp: f64,
    lp_a: f64,
}

/// Cubic Hermite (Catmull-Rom) through y0..y3 at t in [0, 1] between y1 and y2.
#[inline]
fn hermite(y0: f64, y1: f64, y2: f64, y3: f64, t: f64) -> f64 {
    let c1 = 0.5 * (y2 - y0);
    let c2 = y0 - 2.5 * y1 + 2.0 * y2 - 0.5 * y3;
    let c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
    ((c3 * t + c2) * t + c1) * t + y1
}

/// Smooth limiter: linear up to 70% of `limit`, then a tanh knee into it.
#[inline]
fn saturate(x: f64, limit: f64) -> f64 {
    let knee = 0.7 * limit;
    let a = x.abs();
    if a <= knee {
        x
    } else {
        let room = limit - knee;
        x.signum() * (knee + room * ((a - knee) / room).tanh())
    }
}

impl BbdState {
    /// `dc_in` / `v_clock` are the input and clock-control node voltages at
    /// the DC operating point; `dt` the solver step.
    pub fn new(spec: Bbd, aux: usize, tap_in: usize, tap_clock: Option<usize>, dc_in: f64, v_clock: f64, dt: f64) -> BbdState {
        let half = spec.stages / 2;
        let size = (half + 64).next_power_of_two();
        let mut bbd = BbdState {
            lp_a: (spec.stages as f64 * spec.cti).clamp(0.0, 0.95),
            spec,
            aux,
            tap_in,
            tap_clock,
            ring: vec![dc_in; size],
            mask: size - 1,
            count: 0.0,
            freq: 0.0,
            xs: [dc_in; HISTORY],
            cs: [0.0; HISTORY],
            next: 1,
            dc: dc_in,
            lp: 0.0,
        };
        bbd.freq = bbd.clock_hz(v_clock);
        for k in 0..HISTORY {
            bbd.cs[k] = -((HISTORY - 1 - k) as f64) * bbd.freq * dt;
        }
        bbd
    }

    /// Clock frequency for a clock-control node voltage.
    pub fn clock_hz(&self, v: f64) -> f64 {
        match &self.spec.clock {
            BbdClock::Fixed { hz } => *hz,
            BbdClock::Rc { r, c, vcc, vth, vf, vmin, tdis, div, .. } => {
                // The capacitor restarts one diode drop below the control
                // node (but not below the discharge transistor's floor) and
                // must stay below the threshold for the oscillator to run.
                let start = (v - vf).max(*vmin).min(vth - 0.05);
                let period = r * c * ((vcc - start) / (vcc - vth)).ln() + tdis;
                1.0 / (period * div)
            }
        }
    }

    pub fn frequency(&self) -> f64 {
        self.freq
    }

    /// Delay (seconds) at the current clock.
    pub fn delay(&self) -> f64 {
        self.spec.stages as f64 / (2.0 * self.freq)
    }

    /// Output voltage for the coming solver step of length `dt`: the input
    /// sample that entered `stages / 2` clock periods before that step ends.
    #[inline]
    pub fn begin_step(&mut self, dt: f64) -> f64 {
        let end = self.count + self.freq * dt;
        let p = end - (self.spec.stages / 2) as f64;
        let i = p.floor();
        let t = p - i;
        let i = i as i64;
        let m = self.mask as i64;
        let at = |k: i64| self.ring[(k & m) as usize];
        hermite(at(i - 1), at(i), at(i + 1), at(i + 2), t)
    }

    /// Record the step just solved: `x` is the input node voltage at its end
    /// and `v_clock` the clock-control voltage (sets the next step's clock).
    #[inline]
    pub fn end_step(&mut self, dt: f64, x: f64, v_clock: f64) {
        let start = self.count;
        self.count += self.freq * dt;
        self.xs.rotate_left(1);
        self.cs.rotate_left(1);
        self.xs[HISTORY - 1] = x;
        self.cs[HISTORY - 1] = self.count;
        debug_assert!(start == self.cs[HISTORY - 2]);
        // Clock instants inside the previous interval (c[1], c[2]] are now
        // bracketed by two solver samples on each side.
        let (c1, c2) = (self.cs[1], self.cs[2]);
        let span = c2 - c1;
        if span > 0.0 {
            while (self.next as f64) <= c2 {
                let t = ((self.next as f64 - c1) / span).clamp(0.0, 1.0);
                let v = hermite(self.xs[0], self.xs[1], self.xs[2], self.xs[3], t);
                self.push(v);
            }
        }
        self.freq = self.clock_hz(v_clock);
    }

    #[inline]
    fn push(&mut self, v: f64) {
        let mut dev = v - self.dc;
        if let Some(limit) = self.spec.clip {
            dev = saturate(dev, limit);
        }
        self.lp = self.lp_a * self.lp + (1.0 - self.lp_a) * dev;
        let idx = (self.next & self.mask as i64) as usize;
        self.ring[idx] = self.dc + self.spec.gain * self.lp;
        self.next += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::PI;

    fn spec(clock: BbdClock, cti: f64) -> Bbd {
        Bbd { source: "Vb".into(), input: "in".into(), stages: 1024, clock, cti, gain: 1.0, clip: None }
    }

    /// Run `x(t)` through a BBD at solver rate `fs` with clock `clock(t)`
    /// (fixed-mode spec, frequency overridden per step); returns the output.
    fn run(bbd: &mut BbdState, fs: f64, n: usize, x: impl Fn(f64) -> f64, clock: impl Fn(f64) -> f64) -> Vec<f64> {
        let dt = 1.0 / fs;
        (0..n)
            .map(|k| {
                let t = k as f64 * dt;
                let y = bbd.begin_step(dt);
                bbd.end_step(dt, x(t), 0.0);
                bbd.freq = clock(t + dt);
                y
            })
            .collect()
    }

    #[test]
    fn fixed_clock_is_an_ideal_delay_of_stages_over_twice_the_clock() {
        let fs = 96_000.0;
        let fc = 100_000.0;
        let mut bbd = BbdState::new(spec(BbdClock::Fixed { hz: fc }, 0.0), 0, 0, None, 0.0, 0.0, 1.0 / fs);
        let delay = 1024.0 / (2.0 * fc);
        assert!((bbd.delay() - delay).abs() < 1e-12);
        let f = 1_000.0;
        let n = 9_600;
        let y = run(&mut bbd, fs, n, |t| (2.0 * PI * f * t).sin(), |_| fc);
        // One extra solver step of latency comes from sampling the input
        // after each step.
        let lag = delay;
        let (mut err, mut sig) = (0.0, 0.0);
        for (k, v) in y.iter().enumerate().skip(1_000) {
            let t = k as f64 / fs;
            let ideal = (2.0 * PI * f * (t - lag)).sin();
            err += (v - ideal).powi(2);
            sig += ideal * ideal;
        }
        let nrmse = (err / sig).sqrt();
        println!("fixed 100 kHz clock, 1 kHz sine: NRMSE vs ideal 5.12 ms delay {:.4}%", nrmse * 100.0);
        assert!(nrmse < 2e-3, "NRMSE {nrmse}");
    }

    #[test]
    fn modulated_clock_delay_follows_the_clock_count() {
        // Clock swept 80..120 kHz at 2 Hz: the output at t must equal the
        // input at the time the clock count was N/2 lower.
        let fs = 96_000.0;
        let clock = |t: f64| 100_000.0 + 20_000.0 * (2.0 * PI * 2.0 * t).sin();
        let mut bbd = BbdState::new(spec(BbdClock::Fixed { hz: 100_000.0 }, 0.0), 0, 0, None, 0.0, 0.0, 1.0 / fs);
        let x = |t: f64| (2.0 * PI * 700.0 * t).sin();
        let n = 48_000;
        let y = run(&mut bbd, fs, n, x, clock);
        // Integrate the count exactly as the model does (forward rectangle).
        let dt = 1.0 / fs;
        let mut counts = vec![0.0; n + 1];
        for k in 0..n {
            counts[k + 1] = counts[k] + clock(k as f64 * dt);
        }
        let counts: Vec<f64> = counts.iter().map(|c| c * dt).collect();
        let mut worst: f64 = 0.0;
        for k in 4_000..n {
            let target = counts[k + 1] - 512.0;
            let j = counts.partition_point(|&c| c < target);
            let frac = (target - counts[j - 1]) / (counts[j] - counts[j - 1]);
            let tau = ((j - 1) as f64 + frac) * dt - dt;
            worst = worst.max((y[k] - x(tau)).abs());
        }
        println!("80-120 kHz swept clock, 700 Hz sine: worst error vs clock-count delay {worst:.2e} (unit amplitude)");
        assert!(worst < 5e-3, "worst {worst}");
    }

    #[test]
    fn transfer_inefficiency_is_a_gentle_low_pass() {
        let fs = 96_000.0;
        let fc = 100_000.0;
        let gain = |f: f64, cti: f64| {
            let mut bbd = BbdState::new(spec(BbdClock::Fixed { hz: fc }, cti), 0, 0, None, 0.0, 0.0, 1.0 / fs);
            let y = run(&mut bbd, fs, 19_200, |t| (2.0 * PI * f * t).sin(), |_| fc);
            (y[9_600..].iter().map(|v| v * v).sum::<f64>() / 9_600.0 * 2.0).sqrt()
        };
        let cti = 1e-4;
        let a = 1024.0 * cti;
        for f in [1_000.0, 5_000.0, 10_000.0] {
            let w = 2.0 * PI * f / fc;
            let expected = (1.0 - a) / (1.0 - 2.0 * a * w.cos() + a * a).sqrt();
            let measured = gain(f, cti) / gain(f, 0.0);
            println!("cti 1e-4 at {f} Hz: {:.4} dB (one-pole theory {:.4} dB)", 20.0 * measured.log10(), 20.0 * expected.log10());
            assert!((measured / expected - 1.0).abs() < 2e-3, "{f} Hz: {measured} vs {expected}");
        }
    }

    #[test]
    fn rc_clock_matches_the_charge_time() {
        let clock = BbdClock::Rc { node: "m".into(), r: 150e3, c: 52e-12, vcc: 9.0, vth: 4.5, vf: 0.55, vmin: 0.1, tdis: 0.3e-6, div: 2.0 };
        let bbd = BbdState::new(spec(clock, 0.0), 0, 0, Some(1), 0.0, 1.8, 1.0 / 96_000.0);
        let start: f64 = 1.8 - 0.55;
        let period = 150e3 * 52e-12 * ((9.0 - start) / 4.5).ln() + 0.3e-6;
        assert!((bbd.frequency() - 1.0 / (2.0 * period)).abs() < 1e-6);
        // A higher control voltage starts the charge closer to the threshold:
        // faster clock, shorter delay.
        assert!(bbd.clock_hz(2.5) > bbd.clock_hz(1.0));
    }

    #[test]
    fn saturation_is_linear_below_the_knee() {
        assert_eq!(saturate(0.5, 1.6), 0.5);
        assert!(saturate(10.0, 1.6) <= 1.6 && saturate(10.0, 1.6) > 1.59);
        assert!((saturate(-3.0, 1.6) + saturate(3.0, 1.6)).abs() < 1e-12);
    }
}
