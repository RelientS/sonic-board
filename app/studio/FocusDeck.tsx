'use client';

import { forwardRef, type CSSProperties, type ReactNode } from 'react';

import type { SignalLane } from '../audio/audio-core.ts';
import type { EffectStatus } from '../audio/audio-engine.ts';
import { CAB_SPECS, getAmpSpec, getCabSpec, type AmpSpec } from '../amps/catalog.ts';
import { getEffectSpec, type ControlSpec, type EffectSpec } from '../effects/catalog.ts';
import { getPedalControlLabel } from '../effects/control-labels.ts';
import { engineChip } from './Board.tsx';
import { INPUT_NODE, laneItems, laneOf, MIXER_NODE, nodeOrder, RIG_NODE, type BoardUiState, type Values } from './board-store.ts';
import { KnobControl, type HelpTarget } from './Knob.tsx';
import { RigDeck } from './Rig.tsx';
import type { RigMode } from './rig-model.ts';
import { categoryNames, MiniPedal } from './studio-shared.tsx';

const percent = (id: string, label: string): ControlSpec => ({ id, label, defaultValue: 50, min: 0, max: 100, unit: '%', decimals: 0, curve: 'linear' });
const BLEND_CONTROL = percent('blend', 'A / B 平衡');
const SPREAD_CONTROL = { ...percent('spread', '立体声宽度'), defaultValue: 0 };

export type FocusDeckProps = {
  open: boolean;
  state: BoardUiState;
  values: Values;
  tutorialEnabled: boolean;
  rigView: RigMode;
  amps: AmpSpec[];
  engineStatus: (instanceId: string) => EffectStatus | undefined;
  namLoaded: (spec: EffectSpec) => boolean;
  namSection: (spec: EffectSpec) => ReactNode;
  /** The input node's deck (source, takes, live input, trim). */
  inputSection?: ReactNode;
  /** Short description of the current source, for the input deck's header. */
  inputSubtitle?: string;
  onClose: () => void;
  onStep: (direction: -1 | 1) => void;
  onNudge: (instanceId: string, direction: -1 | 1) => void;
  /** Cables a parked pedal onto the end of the chain. */
  onConnectParked: (instanceId: string) => void;
  onLane: (instanceId: string, lane: SignalLane) => void;
  onBypass: (instanceId: string) => void;
  onRemove: (instanceId: string) => void;
  onValue: (instanceId: string, controlId: string, value: number) => void;
  onRouting: (routing: Partial<BoardUiState['routing']>) => void;
  onRigViewChange: (view: RigMode) => void;
  onPickCombo: (ampId: string) => void;
  onPickHead: (ampId: string) => void;
  onPickCab: (cabId: string) => void;
  onAmpValue: (section: 'ampValues' | 'cabValues', controlId: string, value: number) => void;
  onToggleAmpBypass: () => void;
  onHelp: (target: HelpTarget) => void;
};

/**
 * The bottom deck: the focused node, large. Pedals get big knobs, bypass,
 * move and remove; the mixer gets routing; the rig gets combo/head, amp and
 * cab. ←/→ (or the arrows here) walk along the chain.
 */
export const FocusDeck = forwardRef<HTMLHeadingElement, FocusDeckProps>(function FocusDeck(props, headingRef) {
  const { open, state, values, tutorialEnabled, onClose, onStep, onHelp } = props;
  if (!open) return null;
  const order = nodeOrder(state);
  const position = order.indexOf(state.selected);
  const chained = state.chain.find((item) => item.instanceId === state.selected);
  const pedal = chained ?? state.parked.find((item) => item.instanceId === state.selected);
  const parked = Boolean(pedal && !chained);
  const parallel = state.routing.mode === 'parallel';

  let art: ReactNode;
  let title: string;
  let subtitle: string;
  let actions: ReactNode = null;
  let body: ReactNode;

  if (state.selected === INPUT_NODE && props.inputSection) {
    art = <span className="deck-icon input-icon" aria-hidden="true" />;
    title = '输入';
    subtitle = props.inputSubtitle ?? '吉他从哪里来';
    body = props.inputSection;
  } else if (pedal) {
    const spec = getEffectSpec(pedal.specId);
    const bypassed = state.bypassed.has(pedal.instanceId);
    const row = laneItems(state.chain, state.routing.mode, laneOf(pedal));
    const rowIndex = row.indexOf(pedal);
    const chip = engineChip(spec, props.engineStatus(pedal.instanceId), props.namLoaded(spec));
    art = <MiniPedal spec={spec} size="large" />;
    title = spec.name;
    subtitle = parked ? `${categoryNames[spec.category]}，未接入信号链（不发声）` : `${categoryNames[spec.category]}，${spec.family}${parallel ? `，${laneOf(pedal)} 路` : ''}`;
    actions = (
      <div className="deck-actions">
        {chip && <span className={'engine-chip ' + chip.tone} title={chip.title}>{chip.text}</span>}
        <button type="button" role="switch" aria-checked={!bypassed} className={'deck-bypass' + (bypassed ? '' : ' is-on')} onClick={() => props.onBypass(pedal.instanceId)}>
          <i aria-hidden="true" />{bypassed ? '已旁通' : '已启用'}
        </button>
        {parked && <button type="button" className="deck-connect" onClick={() => props.onConnectParked(pedal.instanceId)}>接到链尾</button>}
        {!parked && <div className="deck-move" role="group" aria-label="在链中的位置">
          <button type="button" aria-label="前移" title="前移（Alt + ←）" disabled={rowIndex <= 0} onClick={() => props.onNudge(pedal.instanceId, -1)}>前移</button>
          <button type="button" aria-label="后移" title="后移（Alt + →）" disabled={rowIndex >= row.length - 1} onClick={() => props.onNudge(pedal.instanceId, 1)}>后移</button>
        </div>}
        {parallel && !parked && (
          <div className="deck-lane" role="radiogroup" aria-label="所在通道">
            {(['A', 'B'] as const).map((lane) => (
              <button key={lane} type="button" role="radio" aria-checked={laneOf(pedal) === lane} className={laneOf(pedal) === lane ? 'active' : ''} onClick={() => props.onLane(pedal.instanceId, lane)}>{lane} 路</button>
            ))}
          </div>
        )}
        <button type="button" className="deck-remove" onClick={() => props.onRemove(pedal.instanceId)}>移除</button>
      </div>
    );
    body = (
      <>
        <div className="deck-knobs" style={{ '--knob-count': spec.controls.length } as CSSProperties}>
          {spec.controls.map((control) => (
            <KnobControl
              key={control.id}
              control={control}
              displayLabel={getPedalControlLabel(spec.id, control.id)}
              value={values[pedal.instanceId]?.[control.id] ?? control.defaultValue}
              disabled={bypassed}
              tutorialEnabled={tutorialEnabled}
              ownerKind="effect"
              modelId={spec.id}
              ownerName={spec.name}
              onChange={(value) => props.onValue(pedal.instanceId, control.id, value)}
              onHelp={onHelp}
            />
          ))}
        </div>
        {spec.nam && props.namSection(spec)}
        <p className="deck-description">{spec.description}</p>
      </>
    );
  } else if (state.selected === MIXER_NODE) {
    art = <span className="deck-icon" aria-hidden="true">{parallel ? 'Σ' : '→'}</span>;
    title = parallel ? 'A / B 混合' : '信号路由';
    subtitle = parallel ? '两路并联，在这里调平衡和立体声宽度' : '所有单块依次串联';
    body = (
      <div className="mixer-deck">
        <div className="rig-view route-mode" role="radiogroup" aria-label="串联或并联">
          {(['serial', 'parallel'] as const).map((mode) => (
            <button key={mode} type="button" role="radio" aria-checked={state.routing.mode === mode} className={state.routing.mode === mode ? 'active' : ''} onClick={() => props.onRouting({ mode })}>
              <strong>{mode === 'serial' ? '串联' : '双路并联'}</strong>
              <small>{mode === 'serial' ? '一条链，单块依次处理' : '分成 A、B 两路，再混合'}</small>
            </button>
          ))}
        </div>
        <div className="deck-knobs mixer-knobs">
          {[BLEND_CONTROL, SPREAD_CONTROL].map((control) => (
            <KnobControl
              key={control.id}
              control={control}
              value={state.routing[control.id as 'blend' | 'spread']}
              disabled={!parallel}
              tutorialEnabled={false}
              ownerKind="effect"
              modelId="routing"
              ownerName="混合"
              onChange={(value) => props.onRouting({ [control.id]: value })}
              onHelp={onHelp}
            />
          ))}
        </div>
        {!parallel && <p className="deck-description">切到双路并联后，这里可以调 A/B 平衡和立体声宽度。</p>}
      </div>
    );
  } else {
    const amp = getAmpSpec(state.amp.ampId);
    const cab = getCabSpec(state.amp.cabId);
    art = <span className="deck-icon rig-icon" aria-hidden="true" />;
    title = '音箱';
    subtitle = amp.format === 'combo' && amp.speakerCab === cab.id ? `${amp.name}（单体）` : `${amp.name} + ${cab.name}`;
    body = (
      <RigDeck
        view={props.rigView}
        amps={props.amps}
        amp={amp}
        cab={cab}
        bypassed={state.amp.bypassed}
        cabs={CAB_SPECS}
        ampKnobs={<div className="deck-knobs output-knobs">{amp.controls.map((control) => (
          <KnobControl key={control.id} control={control} value={state.amp.ampValues[control.id] ?? control.defaultValue} disabled={state.amp.bypassed} tutorialEnabled={tutorialEnabled} ownerKind="amp" modelId={amp.id} ownerName={amp.name} onChange={(value) => props.onAmpValue('ampValues', control.id, value)} onHelp={onHelp} />
        ))}</div>}
        cabKnobs={<div className="deck-knobs output-knobs cab-knobs">{cab.controls.map((control) => (
          <KnobControl key={control.id} control={control} value={state.amp.cabValues[control.id] ?? control.defaultValue} disabled={state.amp.bypassed} tutorialEnabled={tutorialEnabled} ownerKind="cab" modelId={cab.id} ownerName={cab.name} onChange={(value) => props.onAmpValue('cabValues', control.id, value)} onHelp={onHelp} />
        ))}</div>}
        onViewChange={props.onRigViewChange}
        onPickCombo={props.onPickCombo}
        onPickHead={props.onPickHead}
        onPickCab={props.onPickCab}
        onToggleBypass={props.onToggleAmpBypass}
      />
    );
  }

  return (
    <section id="focus-deck" className={'focus-deck' + (state.selected === RIG_NODE ? ' is-rig' : '') + (state.selected === INPUT_NODE ? ' is-input' : '')} aria-labelledby="focus-deck-title">
      <header className="deck-header">
        <div className="deck-title">
          {art}
          <div>
            <h2 id="focus-deck-title" ref={headingRef} tabIndex={-1}>{title}</h2>
            <p>{subtitle}</p>
          </div>
        </div>
        {actions}
        <div className="deck-nav">
          <button type="button" aria-label="上一个" title="上一个（←）" disabled={position < 0} onClick={() => onStep(-1)}>‹</button>
          <span aria-live="polite">{position < 0 ? '输入' : `${position + 1} / ${order.length}`}</span>
          <button type="button" aria-label="下一个" title="下一个（→）" disabled={position >= order.length - 1} onClick={() => onStep(1)}>›</button>
          <button type="button" className="deck-close" aria-label="收起面板" title="收起（Esc）" onClick={onClose}>收起</button>
        </div>
      </header>
      <div className="deck-body">{body}</div>
    </section>
  );
});
