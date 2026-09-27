import { CAB_SPECS, getCabSpec, makeDefaultAmpValues, makeDefaultCabValues, type AmpCabConfig, type AmpSpec, type CabSpec } from '../amps/catalog.ts';

/** How the rig is built: a combo carries its own speaker, a head plays through a separate cab. */
export type RigMode = 'combo' | 'head';

export function rigModeOf(amp: AmpSpec): RigMode {
  return amp.format === 'combo' ? 'combo' : 'head';
}

export function combosIn(amps: AmpSpec[]) {
  return amps.filter((amp) => amp.format === 'combo');
}

export function headsIn(amps: AmpSpec[]) {
  return amps.filter((amp) => amp.format !== 'combo');
}

/**
 * The amp section after picking a combo: its built-in speaker becomes the cab.
 * Mic settings are kept when the speaker does not change. A combo whose
 * speaker is unknown keeps the current cab.
 */
export function withCombo(current: AmpCabConfig, combo: AmpSpec): AmpCabConfig {
  const cabId = combo.speakerCab ?? current.cabId;
  return {
    ...current,
    ampId: combo.id,
    ampValues: makeDefaultAmpValues(combo.id),
    cabId,
    cabValues: cabId === current.cabId ? current.cabValues : makeDefaultCabValues(cabId),
  };
}

/** Picking a head leaves the cab alone: heads pair freely with any cab. */
export function withHead(current: AmpCabConfig, head: AmpSpec): AmpCabConfig {
  return { ...current, ampId: head.id, ampValues: makeDefaultAmpValues(head.id) };
}

export function withCab(current: AmpCabConfig, cabId: string): AmpCabConfig {
  return { ...current, cabId, cabValues: makeDefaultCabValues(cabId) };
}

/** Number of 12-inch speakers drawn for a cab (0 for a direct/full-range output). */
export function speakerCount(cab: CabSpec) {
  if (cab.voicing.impulseSeconds <= 0) return 0;
  const match = /(\d)\s*×\s*12/.exec(cab.name);
  return match ? Number(match[1]) : 2;
}

export function cabList() {
  return CAB_SPECS;
}

export function speakerOf(amp: AmpSpec) {
  return amp.speakerCab ? getCabSpec(amp.speakerCab) : null;
}
