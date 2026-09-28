/**
 * Real enclosure sizes (mm), from the width/height in inches that
 * PedalPlayground lists for each unit, keyed by our catalog spec id.
 * Pedals not listed fall back to a size class in board-geometry.
 */
export const PEDAL_FOOTPRINTS_MM: Record<string, { w: number; h: number }> = {
  'analog-chorus': { w: 73, h: 130 }, // BOSS CE-2 Chorus
  'analog-delay': { w: 203, h: 174.5 }, // Electro-Harmonix Deluxe Memory Man (Big Box)
  'bias-tremolo': { w: 73, h: 130 }, // BOSS TR-2 Tremolo
  'blue-drive': { w: 73, h: 130 }, // BOSS BD-2 Blues Driver
  'chainsaw-dist': { w: 73, h: 130 }, // BOSS HM-2 Heavy Metal
  'cloud-hall': { w: 171.5, h: 124.5 }, // Strymon BigSky
  'digital-delay': { w: 73, h: 130 }, // BOSS DD-8 Digital Delay
  'dm2-delay': { w: 73, h: 130 }, // BOSS DM-2 Delay
  'ds1-dist': { w: 73, h: 130 }, // BOSS DS-1 Distortion
  'fuzz-face': { w: 178, h: 179 }, // Dunlop Jimi Hendrix Fuzz Face
  'fuzz-war-nam': { w: 120, h: 149 }, // Death By Audio Fuzz War
  'graphic-eq': { w: 73, h: 130 }, // BOSS GE-7 Graphic Equalizer
  'jet-flanger': { w: 203, h: 174.5 }, // Electro-Harmonix Deluxe Electric Mistress (Big Box)
  'klon-centaur': { w: 165, h: 128 }, // Klon Centaur (Gold)
  'noise-gate': { w: 73, h: 130 }, // BOSS NS-2 Noise Suppressor
  'ocd-drive': { w: 70, h: 114.5 }, // Fulltone OCD
  'opamp-muff': { w: 71.5, h: 114.5 }, // Electro-Harmonix Op-amp Big Muff Pi
  'phase90': { w: 68, h: 114.5 }, // MXR Phase 90 (Script LED)
  'rodent-dist': { w: 89, h: 105 }, // Pro Co Rat 2
  'sd1-drive': { w: 73, h: 130 }, // BOSS SD-1 Super Overdrive
  'slow-phase': { w: 71.5, h: 114.5 }, // Electro-Harmonix Small Stone
  'soft-detune': { w: 101.5, h: 115.5 }, // Eventide MicroPitch Delay
  'studio-comp': { w: 68, h: 114.5 }, // MXR Custom Shop Dyna Comp (Script)
  'tape-vibrato': { w: 73, h: 130 }, // BOSS VB-2 Vibrato
  'tube-screamer': { w: 73.5, h: 124 }, // Ibanez TS808 Tubescreamer
  'wall-fuzz': { w: 71.5, h: 114.5 }, // Electro-Harmonix J Mascis Ram's Head Big Muff Pi
};
