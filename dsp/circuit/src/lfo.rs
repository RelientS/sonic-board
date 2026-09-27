//! Internal low-frequency oscillators (`*@lfo`), evaluated per solver step
//! and fed to the DK solver as extra input columns.

use crate::netlist::{Lfo, LfoRate, LfoShape};

#[derive(Clone, Debug)]
pub struct LfoState {
    pub spec: Lfo,
    value: f64,
    /// Sine/triangle phase in cycles [0, 1).
    phase: f64,
    rising: bool,
    freq: f64,
    /// Relax: time constant and the charge targets seen through the load.
    tau: f64,
    towards_hi: f64,
    towards_lo: f64,
}

/// Relaxation period in units of tau (charging up plus discharging down).
fn relax_period_taus(lo: f64, hi: f64, to_lo: f64, to_hi: f64) -> f64 {
    ((to_hi - lo) / (to_hi - hi)).ln() + ((hi - to_lo) / (lo - to_lo)).ln()
}

impl LfoState {
    /// `start` is the oscillator's initial voltage (the source's DC value).
    pub fn new(spec: Lfo, start: f64, position: f64) -> LfoState {
        let mut lfo = LfoState {
            value: start.clamp(spec.lo, spec.hi),
            phase: 0.0,
            rising: true,
            freq: 1.0,
            tau: 1.0,
            towards_hi: spec.hi,
            towards_lo: spec.lo,
            spec,
        };
        let x = (lfo.value - lfo.spec.lo) / (lfo.spec.hi - lfo.spec.lo);
        lfo.phase = match lfo.spec.shape {
            LfoShape::Triangle => x / 2.0,
            // Rising zero crossing of sin at phase 0.
            LfoShape::Sine => (2.0 * x - 1.0).clamp(-1.0, 1.0).asin() / (2.0 * std::f64::consts::PI),
            LfoShape::Relax { .. } => 0.0,
        }
        .rem_euclid(1.0);
        lfo.set_position(position);
        lfo
    }

    pub fn value(&self) -> f64 {
        self.value
    }

    /// Oscillation frequency in Hz at the current rate setting.
    pub fn frequency(&self) -> f64 {
        self.freq
    }

    /// Apply the rate control (0..1).
    pub fn set_position(&mut self, position: f64) {
        let pos = position.clamp(0.0, 1.0);
        let (lo, hi) = (self.spec.lo, self.spec.hi);
        match (&self.spec.shape, &self.spec.rate) {
            (LfoShape::Relax { target_lo, target_hi }, rate) => {
                let (r, cap) = match *rate {
                    LfoRate::Rc { cap, series, pot, taper } => (series + pot * (1.0 - taper.fraction(pos)), cap),
                    LfoRate::Hz { .. } => (0.0, 0.0),
                };
                // A resistive load on the timing capacitor shifts the charge
                // targets (Thevenin) and shortens tau.
                let (to_lo, to_hi, r_eff) = match self.spec.load {
                    Some((rl, vl)) if r > 0.0 => {
                        let mix = |t: f64| (t * rl + vl * r) / (r + rl);
                        (mix(*target_lo), mix(*target_hi), r * rl / (r + rl))
                    }
                    _ => (*target_lo, *target_hi, r),
                };
                self.towards_lo = to_lo;
                self.towards_hi = to_hi;
                let taus = relax_period_taus(lo, hi, to_lo, to_hi);
                match self.spec.rate {
                    LfoRate::Rc { .. } => {
                        self.tau = cap * r_eff.max(1e-3);
                        self.freq = 1.0 / (self.tau * taus);
                    }
                    LfoRate::Hz { min, max } => {
                        self.freq = min * (max / min).powf(pos);
                        self.tau = 1.0 / (self.freq * taus);
                    }
                }
            }
            (_, LfoRate::Hz { min, max }) => self.freq = min * (max / min).powf(pos),
            // Parsing rejects RC timing for sine/triangle; keep a sane rate.
            (_, LfoRate::Rc { cap, series, pot, taper }) => {
                self.freq = 1.0 / (cap * (series + pot * (1.0 - taper.fraction(pos)))).max(1e-3)
            }
        }
    }

    /// Advance by `dt` seconds and return the new voltage.
    pub fn next(&mut self, dt: f64) -> f64 {
        let (lo, hi) = (self.spec.lo, self.spec.hi);
        match self.spec.shape {
            LfoShape::Relax { .. } => {
                // Exact exponential segments, switching direction at each
                // threshold even inside one step.
                let mut left = dt;
                for _ in 0..8 {
                    let (target, bound) = if self.rising { (self.towards_hi, hi) } else { (self.towards_lo, lo) };
                    let next = target + (self.value - target) * (-left / self.tau).exp();
                    let crossed = if self.rising { next >= bound } else { next <= bound };
                    if !crossed {
                        self.value = next;
                        break;
                    }
                    let used = self.tau * ((self.value - target) / (bound - target)).ln().max(0.0);
                    left -= used.min(left);
                    self.value = bound;
                    self.rising = !self.rising;
                    if left <= 0.0 {
                        break;
                    }
                }
            }
            LfoShape::Triangle => {
                self.phase = (self.phase + self.freq * dt).rem_euclid(1.0);
                let t = if self.phase < 0.5 { 2.0 * self.phase } else { 2.0 - 2.0 * self.phase };
                self.value = lo + (hi - lo) * t;
            }
            LfoShape::Sine => {
                self.phase = (self.phase + self.freq * dt).rem_euclid(1.0);
                let s = (2.0 * std::f64::consts::PI * self.phase).sin();
                self.value = 0.5 * (lo + hi) + 0.5 * (hi - lo) * s;
            }
        }
        self.value
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::netlist::Taper;

    fn relax(rate: LfoRate) -> Lfo {
        Lfo {
            source: "V".into(),
            shape: LfoShape::Relax { target_lo: 1.5, target_hi: 7.5 },
            control: None,
            lo: 4.2,
            hi: 5.7,
            rate,
            load: None,
        }
    }

    /// Period measured from rising threshold crossings.
    fn measure(lfo: &mut LfoState, rate: f64, seconds: f64) -> f64 {
        let dt = 1.0 / rate;
        let mut crossings = Vec::new();
        let mut prev = lfo.value();
        let mid = 0.5 * (lfo.spec.lo + lfo.spec.hi);
        for k in 0..(seconds * rate) as usize {
            let v = lfo.next(dt);
            if prev < mid && v >= mid {
                crossings.push(k as f64 * dt);
            }
            prev = v;
        }
        (crossings[crossings.len() - 1] - crossings[1]) / (crossings.len() - 2) as f64
    }

    #[test]
    fn relax_period_matches_rc_theory() {
        let rate = LfoRate::Rc { cap: 15e-6, series: 4.7e3, pot: 500e3, taper: Taper::RevLog };
        let mut lfo = LfoState::new(relax(rate), 4.9, 0.75);
        let r = 4.7e3 + 500e3 * (1.0 - Taper::RevLog.fraction(0.75));
        let expected = 15e-6 * r * relax_period_taus(4.2, 5.7, 1.5, 7.5);
        let period = measure(&mut lfo, 4_800.0, 10.0);
        assert!((period / expected - 1.0).abs() < 2e-3, "period {period} expected {expected}");
        assert!((1.0 / lfo.frequency() - expected).abs() < 1e-9);
    }

    #[test]
    fn hz_mapping_and_shapes_stay_in_bounds() {
        for shape in [LfoShape::Sine, LfoShape::Triangle] {
            let spec = Lfo { shape, rate: LfoRate::Hz { min: 0.5, max: 8.0 }, ..relax(LfoRate::Hz { min: 1.0, max: 1.0 }) };
            let mut lfo = LfoState::new(spec, 4.9, 0.5);
            assert!((lfo.frequency() - 2.0).abs() < 1e-12);
            let period = measure(&mut lfo, 48_000.0, 5.0);
            assert!((period - 0.5).abs() < 1e-3, "{period}");
            for _ in 0..48_000 {
                let v = lfo.next(1.0 / 48_000.0);
                assert!((4.2 - 1e-9..=5.7 + 1e-9).contains(&v));
            }
        }
        let mut lfo = LfoState::new(relax(LfoRate::Hz { min: 0.1, max: 10.0 }), 4.9, 1.0);
        let period = measure(&mut lfo, 48_000.0, 3.0);
        assert!((period - 0.1).abs() < 1e-3, "{period}");
    }
}
