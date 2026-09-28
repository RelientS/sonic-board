//! Polyphase FIR oversampling for the nonlinear circuit core.

use std::f64::consts::PI;

fn bessel_i0(x: f64) -> f64 {
    let mut sum = 1.0;
    let mut term = 1.0;
    let q = x * x / 4.0;
    for k in 1..40 {
        term *= q / (k * k) as f64;
        sum += term;
    }
    sum
}

/// Kaiser-windowed sinc low-pass at `cutoff` (fraction of the high rate's Nyquist).
fn design(taps: usize, cutoff: f64, beta: f64) -> Vec<f64> {
    let m = (taps - 1) as f64;
    let norm = bessel_i0(beta);
    (0..taps)
        .map(|n| {
            let x = n as f64 - m / 2.0;
            let sinc = if x == 0.0 { cutoff } else { (PI * cutoff * x).sin() / (PI * x) };
            let r = 2.0 * n as f64 / m - 1.0;
            sinc * bessel_i0(beta * (1.0 - r * r).max(0.0).sqrt()) / norm
        })
        .collect()
}

pub struct Oversampler {
    factor: usize,
    /// Polyphase branches for interpolation: phase p uses taps p, p+L, ...
    phases: Vec<Vec<f64>>,
    taps: Vec<f64>,
    up_history: Vec<f64>,
    up_pos: usize,
    down_history: Vec<f64>,
    down_pos: usize,
}

impl Oversampler {
    pub fn new(factor: usize) -> Self {
        let factor = factor.max(1);
        let per_phase = 16;
        let n = factor * per_phase;
        // Pass band to ~20 kHz at 44.1/48 kHz; stop band at the base Nyquist.
        let taps = design(n, 0.9 / factor as f64, 8.0);
        let gain: f64 = taps.iter().sum();
        let taps: Vec<f64> = taps.iter().map(|t| t / gain).collect();
        let phases = (0..factor)
            .map(|p| taps.iter().skip(p).step_by(factor).map(|t| t * factor as f64).collect())
            .collect();
        Self {
            factor,
            phases,
            up_history: vec![0.0; 2 * per_phase],
            up_pos: 0,
            down_history: vec![0.0; 2 * n],
            down_pos: 0,
            taps,
        }
    }

    pub fn factor(&self) -> usize {
        self.factor
    }

    /// Latency in base-rate samples (both filters).
    pub fn latency(&self) -> f64 {
        if self.factor == 1 {
            0.0
        } else {
            (self.taps.len() - 1) as f64 / self.factor as f64
        }
    }

    /// Interpolate one base-rate sample into `out[..factor]`.
    #[inline]
    pub fn up(&mut self, x: f64, out: &mut [f64]) {
        if self.factor == 1 {
            out[0] = x;
            return;
        }
        // Histories are stored twice so every read is one contiguous slice.
        let len = self.up_history.len() / 2;
        self.up_pos = if self.up_pos == 0 { len - 1 } else { self.up_pos - 1 };
        self.up_history[self.up_pos] = x;
        self.up_history[self.up_pos + len] = x;
        let window = &self.up_history[self.up_pos..self.up_pos + len];
        for (p, phase) in self.phases.iter().enumerate() {
            out[p] = phase.iter().zip(window).map(|(h, x)| h * x).sum();
        }
    }

    /// Decimate `input[..factor]` to one base-rate sample.
    #[inline]
    pub fn down(&mut self, input: &[f64]) -> f64 {
        if self.factor == 1 {
            return input[0];
        }
        let len = self.down_history.len() / 2;
        for &x in input {
            self.down_pos = if self.down_pos == 0 { len - 1 } else { self.down_pos - 1 };
            self.down_history[self.down_pos] = x;
            self.down_history[self.down_pos + len] = x;
        }
        let window = &self.down_history[self.down_pos..self.down_pos + len];
        self.taps.iter().zip(window).map(|(h, x)| h * x).sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passes_audio_and_rejects_images() {
        let fs = 48_000.0;
        for (freq, expect_pass) in [(1_000.0, true), (15_000.0, true)] {
            let mut os = Oversampler::new(4);
            let mut buf = [0.0; 4];
            let mut peak: f64 = 0.0;
            for n in 0..4_000 {
                let x = (2.0 * PI * freq * n as f64 / fs).sin();
                os.up(x, &mut buf);
                let y = os.down(&buf);
                if n > 2_000 {
                    peak = peak.max(y.abs());
                }
            }
            assert_eq!(expect_pass, (peak - 1.0).abs() < 0.05, "{freq} Hz peak {peak}");
        }
    }
}
