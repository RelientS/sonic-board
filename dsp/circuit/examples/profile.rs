//! Per-quantum cost of a model under the browser harness signal: a decaying
//! 110 + 165 Hz chord restruck every second, 128-sample blocks at 48 kHz.
//!
//! cargo run --release --example profile -- <model-id> [amp] [c0,c1,..] [seconds]
//!
//! Prints mean/worst block time and, for the slowest blocks, which rescue
//! paths ran (restarts, homotopy, Levenberg-Marquardt, sub-step levels, lazy
//! matrix builds), the real-time guard's activity and its error against an
//! unguarded run, and the cost of a knob change.
//! env: REPEATS (fastest of N runs per block, default 3), GUARD=0, DEBUG=1
use sonic_board_circuit::models::MODELS;
use sonic_board_circuit::pedal::Pedal;
use std::time::Instant;

fn main() {
    if std::env::var("DEBUG").is_ok() {
        sonic_board_circuit::solver::DEBUG_NEWTON.store(true, std::sync::atomic::Ordering::Relaxed);
    }

    let args: Vec<String> = std::env::args().skip(1).collect();
    let id = args.first().expect("model id");
    let amp: f64 = args.get(1).map(|a| a.parse().unwrap()).unwrap_or(0.3);
    let controls: Vec<f64> = args
        .get(2)
        .map(|c| c.split(',').filter(|v| !v.is_empty()).map(|v| v.parse().unwrap()).collect())
        .unwrap_or_default();
    let seconds: f64 = args.get(3).map(|a| a.parse().unwrap()).unwrap_or(2.0);
    let model = MODELS.iter().find(|m| m.id == id).expect("unknown model");
    let repeats: usize = std::env::var("REPEATS").ok().and_then(|r| r.parse().ok()).unwrap_or(3);
    let blocks = (seconds * 48_000.0 / 128.0) as usize;
    // The run is deterministic: keep each block's fastest time over several
    // repeats so scheduler noise on a shared machine does not show as a spike.
    let mut times = vec![f64::INFINITY; blocks];
    let mut notes = Vec::new();
    let mut energy = 0.0f64;
    let mut pedal = Pedal::new(model.source, 48_000.0).unwrap();
    // Unguarded reference run on the same input: the guard's accuracy cost.
    let mut reference = Pedal::new(model.source, 48_000.0).unwrap();
    reference.set_realtime(false);
    for (i, &c) in controls.iter().enumerate() {
        reference.set_control(i, c);
    }
    let (mut err2, mut ref2) = (0.0f64, 0.0f64);
    for rep in 0..repeats {
        pedal = Pedal::new(model.source, 48_000.0).unwrap();
        // GUARD=0 profiles without the real-time work cap.
        pedal.set_realtime(std::env::var("GUARD").map(|g| g != "0").unwrap_or(true));
        for (i, &c) in controls.iter().enumerate() {
            pedal.set_control(i, c);
        }
        let mut n = 0u64;
        let mut prev = pedal.diagnostics();
        let (mut s0, mut i0, mut f0) = pedal.stats();
        let mut r0 = pedal.refactors();
        for block in 0..blocks {
            let mut buf = [0f32; 128];
            for s in buf.iter_mut() {
                let t = n as f64 / 48_000.0;
                *s = (amp * (-2.0 * (t % 1.0)).exp() * ((2.0 * std::f64::consts::PI * 110.0 * t).sin() + 0.6 * (2.0 * std::f64::consts::PI * 165.0 * t).sin())) as f32;
                n += 1;
            }
            let mut refbuf = buf;
            let t0 = Instant::now();
            pedal.process(&mut buf);
            let ms = t0.elapsed().as_secs_f64() * 1e3;
            if rep == 0 {
                reference.process(&mut refbuf);
                for (a, b) in buf.iter().zip(refbuf.iter()) {
                    err2 += ((*a - *b) as f64).powi(2);
                    ref2 += (*b as f64).powi(2);
                }
            }
            times[block] = times[block].min(ms);
            if rep > 0 {
                continue;
            }
            energy += buf.iter().map(|x| (*x as f64).powi(2)).sum::<f64>();
            let d = pedal.diagnostics();
            let (s1, i1, f1) = pedal.stats();
            let tries: Vec<u64> = d.substep_tries.iter().zip(prev.substep_tries.iter()).map(|(a, b)| a - b).collect();
            notes.push((
                block,
                format!(
                    "iters/sample {:.1} refactors/sample {:.2} restarts {} retries {} lm {} homotopy {} substeps {:?} builds {} failures {}",
                    (i1 - i0) as f64 / (s1 - s0).max(1) as f64,
                    (pedal.refactors() - r0) as f64 / (s1 - s0).max(1) as f64,
                    d.restarts - prev.restarts,
                    d.retries - prev.retries,
                    d.lm - prev.lm,
                    d.homotopy - prev.homotopy,
                    &tries[1..6],
                    d.lazy_builds - prev.lazy_builds,
                    f1 - f0
                ),
            ));
            prev = d;
            r0 = pedal.refactors();
            s0 = s1;
            i0 = i1;
            f0 = f1;
        }
    }
    let mut notes: Vec<(f64, usize, String)> = notes.into_iter().map(|(b, n)| (times[b], b, n)).collect();
    let mean = times.iter().sum::<f64>() / times.len() as f64;
    let worst = times.iter().cloned().fold(0.0, f64::max);
    notes.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());
    // Block 0 carries one-off setup (first factorization); report it apart.
    let worst_after_first = times[1..].iter().cloned().fold(0.0, f64::max);
    let rms_db = 10.0 * (energy / (blocks * 128) as f64 + 1e-20).log10();
    let (samples, iters, failures) = pedal.stats();
    let d = pedal.diagnostics();
    println!(
        "{id} amp {amp} controls {controls:?}: mean {mean:.3} ms worst {worst:.3} ms (after block 0: {worst_after_first:.3}) (budget 2.667), level {rms_db:.1} dBFS, iters/sample {:.2}, failures {failures}, restarts {} retries {} lm {} homotopy {} substeps {:?} builds {} guarded {} lm_ok {} relaxed {} | vs unguarded NRMSE {:.4}%",
        iters as f64 / samples as f64,
        d.restarts,
        d.retries,
        d.lm,
        d.homotopy,
        &d.substep_tries[1..6],
        d.lazy_builds,
        d.guarded,
        d.lm_ok,
        d.relaxed,
        100.0 * (err2 / ref2.max(1e-30)).sqrt()
    );
    // Cost of a knob move: the matrices are rebuilt on the audio thread.
    let mut commit_worst = 0.0f64;
    let mut commit_total = 0.0f64;
    for k in 0..20 {
        for c in 0..pedal.control_count() {
            pedal.set_control(c, 0.2 + 0.03 * k as f64);
        }
        let t0 = Instant::now();
        pedal.commit();
        let ms = t0.elapsed().as_secs_f64() * 1e3;
        commit_worst = commit_worst.max(ms);
        commit_total += ms;
    }
    println!("  knob change (matrix rebuild): mean {:.3} ms worst {:.3} ms", commit_total / 20.0, commit_worst);
    for (ms, block, note) in notes.iter().take(4) {
        println!("  {ms:.3} ms @ block {block}: {note}");
    }
}
