//! Circuit files compiled into the runtime. Order defines the model IDs, so
//! only append.

pub struct ModelSource {
    pub id: &'static str,
    pub source: &'static str,
}

pub const MODELS: &[ModelSource] = &[
    ModelSource { id: "rams-head-muff", source: include_str!("../models/rams_head_muff.cir") },
    ModelSource { id: "proco-rat2", source: include_str!("../models/proco_rat2.cir") },
    ModelSource { id: "boss-ds1", source: include_str!("../models/boss_ds1.cir") },
    ModelSource { id: "boss-bd2", source: include_str!("../models/boss_bd2.cir") },
    ModelSource { id: "opamp-big-muff", source: include_str!("../models/opamp_big_muff.cir") },
    ModelSource { id: "klon-centaur", source: include_str!("../models/klon_centaur.cir") },
    ModelSource { id: "fuzz-face", source: include_str!("../models/fuzz_face.cir") },
    ModelSource { id: "ibanez-ts808", source: include_str!("../models/ibanez_ts808.cir") },
    ModelSource { id: "boss-sd1", source: include_str!("../models/boss_sd1.cir") },
    ModelSource { id: "fulltone-ocd", source: include_str!("../models/fulltone_ocd.cir") },
    ModelSource { id: "mxr-phase90", source: include_str!("../models/mxr_phase90.cir") },
    ModelSource { id: "mxr-dynacomp", source: include_str!("../models/mxr_dynacomp.cir") },
    ModelSource { id: "boss-ce2", source: include_str!("../models/boss_ce2.cir") },
];

pub fn find(id: &str) -> Option<usize> {
    MODELS.iter().position(|m| m.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pedal::Pedal;

    #[test]
    fn every_bundled_model_builds_and_runs() {
        for m in MODELS {
            let mut pedal = Pedal::new(m.source, 48_000.0).unwrap_or_else(|e| panic!("{}: {e}", m.id));
            let mut block: Vec<f32> = (0..512).map(|k| (0.2 * (k as f32 * 0.05).sin())).collect();
            pedal.process(&mut block);
            assert!(block.iter().all(|x| x.is_finite()), "{}", m.id);
            assert_eq!(pedal.stats().2, 0, "{} Newton failures", m.id);
        }
    }

    /// Every knob at its extremes with a hot input: the solver must converge
    /// (no held samples) and keep the output audible. The BD-2 with Level and
    /// Gain at max used to stall with its output op-amp against the rail,
    /// freezing the output (heard as silence).
    #[test]
    fn extreme_knobs_converge_and_stay_audible() {
        for m in MODELS {
            for knob in [0.0, 1.0] {
                let mut pedal = Pedal::new(m.source, 48_000.0).unwrap();
                pedal.set_realtime(false);
                for c in 0..pedal.control_count() {
                    pedal.set_control(c, knob);
                }
                let mut energy = 0.0f64;
                let mut n = 0usize;
                for _ in 0..(48_000 / 4 / 128) {
                    let mut block = [0f32; 128];
                    for s in block.iter_mut() {
                        let t = n as f64 / 48_000.0;
                        *s = (0.8 * ((2.0 * std::f64::consts::PI * 110.0 * t).sin() + 0.6 * (2.0 * std::f64::consts::PI * 165.0 * t).sin())) as f32;
                        n += 1;
                    }
                    pedal.process(&mut block);
                    energy += block.iter().map(|x| (*x as f64).powi(2)).sum::<f64>();
                }
                assert_eq!(pedal.stats().2, 0, "{} knobs {knob}: Newton failures", m.id);
                if knob == 1.0 {
                    let db = 10.0 * (energy / n as f64 + 1e-20).log10();
                    assert!(db > -40.0, "{} knobs at max is near silent ({db:.1} dBFS)", m.id);
                }
            }
        }
    }
}
