//! Hardware capture kit: compare a circuit model with a reamped real pedal.
//!
//! ```text
//! cargo run --release --example capture -- signal capture-signal.wav
//! cargo run --release --example capture -- compare models/X.cir capture-signal.wav recorded.wav --controls 0.6,0.5,0.7
//! ```
//!
//! `signal` writes a 48 kHz test file: an alignment click, a quiet and a hot
//! log sweep, and DI guitar notes. Reamp it through the pedal at known knob
//! positions and record the output. `compare` aligns the recording, fits the
//! unknown reamp level (the circuit is nonlinear, so input level matters) and
//! the recording gain, then reports error-to-signal ratio per segment and
//! per third-octave band.

use sonic_board_circuit::pedal::{be_elements, Pedal};
use sonic_board_circuit::netlist::Netlist;
use std::f64::consts::PI;
use std::fs;

const RATE: u32 = 48_000;

struct Segment {
    name: &'static str,
    start: f64,
    end: f64,
}

fn read_wav(path: &str) -> (Vec<f64>, u32) {
    let bytes = fs::read(path).unwrap_or_else(|e| panic!("{path}: {e}"));
    let mut pos = 12;
    let (mut channels, mut rate, mut bits, mut format) = (1usize, RATE, 16u16, 1u16);
    let mut data: &[u8] = &[];
    while pos + 8 <= bytes.len() {
        let id = &bytes[pos..pos + 4];
        let size = u32::from_le_bytes(bytes[pos + 4..pos + 8].try_into().unwrap()) as usize;
        let body = &bytes[pos + 8..(pos + 8 + size).min(bytes.len())];
        if id == b"fmt " {
            format = u16::from_le_bytes([body[0], body[1]]);
            channels = u16::from_le_bytes([body[2], body[3]]) as usize;
            rate = u32::from_le_bytes(body[4..8].try_into().unwrap());
            bits = u16::from_le_bytes([body[14], body[15]]);
        } else if id == b"data" {
            data = body;
        }
        pos += 8 + size + (size & 1);
    }
    let frame = channels * bits as usize / 8;
    // First channel only: a reamped pedal is mono.
    let out = data
        .chunks_exact(frame)
        .map(|f| match (format, bits) {
            (3, 32) | (65534, 32) => f32::from_le_bytes(f[0..4].try_into().unwrap()) as f64,
            (_, 16) => i16::from_le_bytes([f[0], f[1]]) as f64 / 32768.0,
            (_, 24) => (i32::from_le_bytes([0, f[0], f[1], f[2]]) >> 8) as f64 / 8_388_608.0,
            (_, 32) => i32::from_le_bytes(f[0..4].try_into().unwrap()) as f64 / 2_147_483_648.0,
            _ => panic!("unsupported wav format {format}/{bits}"),
        })
        .collect();
    (out, rate)
}

fn write_wav(path: &str, samples: &[f64]) {
    let mut out = Vec::with_capacity(44 + samples.len() * 3);
    let data_len = (samples.len() * 3) as u32;
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&RATE.to_le_bytes());
    out.extend_from_slice(&(RATE * 3).to_le_bytes());
    out.extend_from_slice(&3u16.to_le_bytes());
    out.extend_from_slice(&24u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for s in samples {
        let v = (s.clamp(-1.0, 1.0) * 8_388_607.0).round() as i32;
        out.extend_from_slice(&v.to_le_bytes()[..3]);
    }
    fs::write(path, out).unwrap();
}

fn resample(x: &[f64], from: u32, to: u32) -> Vec<f64> {
    if from == to {
        return x.to_vec();
    }
    let ratio = from as f64 / to as f64;
    let n = (x.len() as f64 / ratio) as usize;
    (0..n)
        .map(|i| {
            let t = i as f64 * ratio;
            let k = t as usize;
            let f = t - k as f64;
            let a = x[k.min(x.len() - 1)];
            let b = x[(k + 1).min(x.len() - 1)];
            a + (b - a) * f
        })
        .collect()
}

fn layout() -> Vec<Segment> {
    vec![
        Segment { name: "click", start: 0.5, end: 1.5 },
        Segment { name: "sweep -26 dBFS", start: 1.5, end: 8.0 },
        Segment { name: "sweep -10 dBFS", start: 8.0, end: 14.5 },
        Segment { name: "DI notes", start: 14.5, end: 14.5 + 6.0 * 2.8 },
    ]
}

fn make_signal(guitar_dir: &str) -> Vec<f64> {
    let total = 14.5 + 6.0 * 2.8 + 1.0;
    let mut x = vec![0.0; (total * RATE as f64) as usize];
    let at = |t: f64| (t * RATE as f64) as usize;
    x[at(0.5)] = 0.5;
    for (start, amp) in [(1.5, 0.05), (8.0, 0.316)] {
        // Exponential sweep 20 Hz -> 20 kHz over 6 s with 10 ms fades.
        let dur = 6.0;
        let (f0, f1) = (20.0f64, 20_000.0f64);
        let k = (f1 / f0).ln();
        for i in 0..at(dur) {
            let t = i as f64 / RATE as f64;
            let phase = 2.0 * PI * f0 * dur / k * ((t * k / dur).exp() - 1.0);
            let fade = (t / 0.01).min(1.0).min((dur - t) / 0.01);
            x[at(start) + i] = amp * fade * phase.sin();
        }
    }
    for (n, note) in ["f2", "a2", "d3", "g3", "b3", "e4"].iter().enumerate() {
        let path = format!("{guitar_dir}/{note}.wav");
        let Ok(_) = fs::metadata(&path) else { continue };
        let (samples, rate) = read_wav(&path);
        let s = resample(&samples, rate, RATE);
        let peak = s.iter().fold(0.0f64, |m, v| m.max(v.abs())).max(1e-9);
        let start = at(14.5 + n as f64 * 2.8);
        for (i, v) in s.iter().take(at(2.7)).enumerate() {
            x[start + i] = v / peak * 0.4;
        }
    }
    x
}

fn render(source: &str, net: &Netlist, input: &[f64], gain: f64, controls: &[f64], os: Option<usize>) -> Vec<f64> {
    let mut pedal = Pedal::with_netlist(net.clone(), &be_elements(source), RATE as f64, os).unwrap();
    pedal.set_realtime(false);
    for (i, c) in controls.iter().enumerate() {
        pedal.set_control(i, *c);
    }
    pedal.commit();
    input.iter().map(|x| pedal.process_sample(x * gain)).collect()
}

fn fft(re: &mut [f64], im: &mut [f64], inverse: bool) {
    let n = re.len();
    let mut j = 0;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j |= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let sign = if inverse { 1.0 } else { -1.0 };
    let mut len = 2;
    while len <= n {
        let ang = sign * 2.0 * PI / len as f64;
        for start in (0..n).step_by(len) {
            for k in 0..len / 2 {
                let (wr, wi) = ((ang * k as f64).cos(), (ang * k as f64).sin());
                let (a, b) = (start + k, start + k + len / 2);
                let tr = re[b] * wr - im[b] * wi;
                let ti = re[b] * wi + im[b] * wr;
                re[b] = re[a] - tr;
                im[b] = im[a] - ti;
                re[a] += tr;
                im[a] += ti;
            }
        }
        len <<= 1;
    }
}

/// Lag (samples) of `b` relative to `a` maximizing cross-correlation,
/// computed with an FFT: r[k] = sum a[i] b[i + k].
fn best_lag(a: &[f64], b: &[f64], max_lag: usize) -> isize {
    let n = (a.len() + b.len()).next_power_of_two();
    let (mut ar, mut ai) = (vec![0.0; n], vec![0.0; n]);
    let (mut br, mut bi) = (vec![0.0; n], vec![0.0; n]);
    ar[..a.len()].copy_from_slice(a);
    br[..b.len()].copy_from_slice(b);
    fft(&mut ar, &mut ai, false);
    fft(&mut br, &mut bi, false);
    let (mut cr, mut ci) = (vec![0.0; n], vec![0.0; n]);
    for k in 0..n {
        // conj(A) * B
        cr[k] = ar[k] * br[k] + ai[k] * bi[k];
        ci[k] = ar[k] * bi[k] - ai[k] * br[k];
    }
    fft(&mut cr, &mut ci, true);
    let mut best = (0isize, f64::MIN);
    for lag in -(max_lag as isize)..=(max_lag as isize) {
        let idx = if lag >= 0 { lag as usize } else { n - (-lag) as usize };
        if cr[idx] > best.1 {
            best = (lag, cr[idx]);
        }
    }
    best.0
}

fn shifted(b: &[f64], lag: isize, n: usize) -> Vec<f64> {
    (0..n)
        .map(|i| {
            let j = i as isize + lag;
            if j >= 0 && (j as usize) < b.len() {
                b[j as usize]
            } else {
                0.0
            }
        })
        .collect()
}

/// Least-squares gain of `m` onto `y` and the resulting error-to-signal ratio.
fn esr(y: &[f64], m: &[f64]) -> (f64, f64) {
    let ym: f64 = y.iter().zip(m).map(|(a, b)| a * b).sum();
    let mm: f64 = m.iter().map(|b| b * b).sum::<f64>().max(1e-30);
    let yy: f64 = y.iter().map(|a| a * a).sum::<f64>().max(1e-30);
    let g = ym / mm;
    let err: f64 = y.iter().zip(m).map(|(a, b)| (a - g * b).powi(2)).sum();
    (g, err / yy)
}

fn band_energy(x: &[f64]) -> Vec<f64> {
    // Third-octave band energies via a naive DFT on a 16k window.
    let n = 16_384.min(x.len());
    let centers: Vec<f64> = (0..28).map(|k| 25.0 * 2f64.powf(k as f64 / 3.0)).collect();
    centers
        .iter()
        .map(|&fc| {
            let (lo, hi) = (fc / 2f64.powf(1.0 / 6.0), fc * 2f64.powf(1.0 / 6.0));
            let (k0, k1) = ((lo * n as f64 / RATE as f64) as usize, (hi * n as f64 / RATE as f64).ceil() as usize);
            let mut e = 0.0;
            for k in k0.max(1)..=k1.min(n / 2) {
                let (mut re, mut im) = (0.0, 0.0);
                for (i, v) in x[..n].iter().enumerate() {
                    let w = 0.5 - 0.5 * (2.0 * PI * i as f64 / n as f64).cos();
                    let a = 2.0 * PI * k as f64 * i as f64 / n as f64;
                    re += w * v * a.cos();
                    im -= w * v * a.sin();
                }
                e += re * re + im * im;
            }
            e
        })
        .collect()
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let flag = |k: &str| args.iter().position(|a| a == k).and_then(|i| args.get(i + 1)).cloned();
    match args.first().map(String::as_str) {
        Some("signal") => {
            let out = args.get(1).expect("output path");
            let dir = flag("--guitars").unwrap_or("../../public/audio/guitars/fender-direct-picked".into());
            let x = make_signal(&dir);
            write_wav(out, &x);
            println!("wrote {out}: {:.1}s, 48 kHz 24-bit mono", x.len() as f64 / RATE as f64);
            for s in layout() {
                println!("  {:>6.2}-{:>6.2}s  {}", s.start, s.end, s.name);
            }
        }
        Some("compare") => {
            let source = fs::read_to_string(&args[1]).unwrap();
            let net = Netlist::parse(&source).unwrap();
            let (signal, sr) = read_wav(&args[2]);
            let signal = resample(&signal, sr, RATE);
            let (rec, rr) = read_wav(&args[3]);
            let rec = resample(&rec, rr, RATE);
            let mut controls: Vec<f64> = net.controls.iter().map(|c| c.default).collect();
            if let Some(list) = flag("--controls") {
                for (i, v) in list.split(',').enumerate() {
                    if let (Some(slot), Ok(x)) = (controls.get_mut(i), v.parse()) {
                        *slot = x;
                    }
                }
            }
            let fit_start = (8.0 * RATE as f64) as usize;
            let fit_end = signal.len().min(rec.len());
            let input = &signal[..fit_end];
            // Fit and final render share the model's oversampling factor (its
            // filter latency is part of the alignment). Every trial render is
            // re-aligned, then scored on the hot sweep plus the DI notes.
            let score = |gain_db: f64| -> (f64, isize, Vec<f64>) {
                let m = render(&source, &net, input, 10f64.powf(gain_db / 20.0), &controls, None);
                let lag = best_lag(&m[fit_start..fit_end], &rec[fit_start..fit_end], RATE as usize / 2);
                let y = shifted(&rec, lag, fit_end);
                (esr(&y[fit_start..], &m[fit_start..]).1, lag, m)
            };
            // Golden-section search for the unknown reamp level.
            let (mut lo, mut hi) = (-30.0f64, 15.0f64);
            let phi = 0.618_033_988_75;
            let mut x1 = hi - phi * (hi - lo);
            let mut x2 = lo + phi * (hi - lo);
            let mut f1 = score(x1).0;
            let mut f2 = score(x2).0;
            while hi - lo > 0.1 {
                if f1 < f2 {
                    hi = x2;
                    x2 = x1;
                    f2 = f1;
                    x1 = hi - phi * (hi - lo);
                    f1 = score(x1).0;
                } else {
                    lo = x1;
                    x1 = x2;
                    f1 = f2;
                    x2 = lo + phi * (hi - lo);
                    f2 = score(x2).0;
                }
            }
            let best_db = 0.5 * (lo + hi);
            let (_, lag, m) = score(best_db);
            let best = (best_db, 0.0);
            let y = shifted(&rec, lag, fit_end);
            println!("{} vs {}", net.name, args[3]);
            println!("  alignment lag {lag} samples, fitted input level {:+.2} dB re signal file", best.0);
            for s in layout() {
                let (a, b) = ((s.start * RATE as f64) as usize, ((s.end * RATE as f64) as usize).min(fit_end));
                if b <= a {
                    continue;
                }
                let (g, e) = esr(&y[a..b], &m[a..b]);
                println!("  {:<16} ESR {:>6.2}% ({:>6.1} dB), output gain {:.3}", s.name, e * 100.0, 10.0 * e.max(1e-12).log10(), g);
            }
            let (a, b) = ((14.5 * RATE as f64) as usize, fit_end);
            if b > a + 16_384 {
                let (g, _) = esr(&y[a..b], &m[a..b]);
                let ey = band_energy(&y[a..b]);
                let em = band_energy(&m[a..b].iter().map(|v| v * g).collect::<Vec<_>>());
                println!("  third-octave level difference on DI notes (model - hardware):");
                for (k, (a, b)) in ey.iter().zip(&em).enumerate() {
                    let fc = 25.0 * 2f64.powf(k as f64 / 3.0);
                    if *a > 0.0 && *b > 0.0 {
                        println!("    {:>7.0} Hz {:>+6.1} dB", fc, 10.0 * (b / a).log10());
                    }
                }
            }
        }
        _ => eprintln!("usage: capture signal <out.wav> | capture compare <model.cir> <signal.wav> <recorded.wav> [--controls ..]"),
    }
}
