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
}
