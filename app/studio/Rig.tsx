'use client';

import type { CSSProperties, ReactNode } from 'react';

import { isNamAmp, type AmpSpec, type CabSpec } from '../amps/catalog.ts';
import { combosIn, headsIn, speakerCount, speakerOf, type RigMode } from './rig-model.ts';

function Grille({ speakers, className }: { speakers: number; className?: string }) {
  return (
    <span className={'rig-grille ' + (className ?? '')} data-speakers={speakers}>
      {Array.from({ length: speakers }, (_, index) => <i key={index} />)}
    </span>
  );
}

/**
 * The amp at the end of the signal chain, drawn as the physical object: a
 * combo (one cabinet, control strip over the grille) or a head on a cab.
 */
export function RigObject({ nodeId, amp, cab, bypassed, lit, selected, expanded, compact = false, onOpen }: {
  nodeId: string;
  amp: AmpSpec;
  cab: CabSpec;
  bypassed: boolean;
  lit: boolean;
  selected: boolean;
  expanded: boolean;
  compact?: boolean;
  onOpen: (fromKeyboard: boolean) => void;
}) {
  const combo = amp.format === 'combo' && amp.speakerCab === cab.id;
  const speakers = speakerCount(cab);
  const style = { '--amp-plate': amp.finish, '--amp-logo': amp.accent } as CSSProperties;
  const label = `音箱：${amp.name}${combo ? '（单体）' : `，箱体 ${cab.name}`}${bypassed ? '，已旁通' : ''}。打开音箱面板`;
  return (
    <button
      type="button"
      data-node-id={nodeId}
      className={'rig-object' + (combo ? ' is-combo' : ' is-stack') + (bypassed ? ' is-bypassed' : '') + (lit ? ' is-lit' : '') + (selected ? ' is-selected' : '') + (compact ? ' is-compact' : '')}
      style={style}
      aria-label={label}
      aria-current={selected ? 'true' : undefined}
      aria-expanded={expanded}
      aria-controls="focus-deck"
      onClick={(event) => onOpen(event.detail === 0)}
    >
      {combo ? (
        <span className="rig-cabinet rig-combo" data-speakers={speakers}>
          <span className="rig-panel"><strong>{amp.name}</strong><i className="rig-lamp" aria-hidden="true" /></span>
          <Grille speakers={speakers} />
        </span>
      ) : (
        <span className="rig-stack">
          <span className="rig-cabinet rig-head">
            <span className="rig-panel"><strong>{amp.name}</strong><i className="rig-lamp" aria-hidden="true" /></span>
          </span>
          {speakers > 0 ? (
            <span className="rig-cabinet rig-cab" data-speakers={speakers}>
              <Grille speakers={speakers} />
              <small>{cab.name}</small>
            </span>
          ) : <span className="rig-direct">直出</span>}
        </span>
      )}
    </button>
  );
}

function ModelButton({ model, active, marker, onPick }: { model: AmpSpec | CabSpec; active: boolean; marker?: string; onPick: () => void }) {
  const isAmp = 'accent' in model;
  return (
    <button type="button" role="radio" aria-checked={active} className={active ? 'active' : ''} onClick={onPick}>
      {isAmp && <i style={{ background: (model as AmpSpec).finish }} aria-hidden="true" />}
      <span>
        <strong>{model.name}{marker && <em className="rig-marker">{marker}</em>}</strong>
        <small>{isAmp ? (model as AmpSpec).family : (model as CabSpec).format}</small>
      </span>
    </button>
  );
}

/**
 * The rig's panel in the focus deck: combo or head+cab, the amp's knobs and
 * the cab/speaker with its mic knobs. Measured cabs show their credit.
 */
export function RigDeck({
  view, amps, amp, cab, bypassed, cabs, ampKnobs, cabKnobs,
  onViewChange, onPickCombo, onPickHead, onPickCab, onToggleBypass,
}: {
  view: RigMode;
  amps: AmpSpec[];
  amp: AmpSpec;
  cab: CabSpec;
  bypassed: boolean;
  cabs: CabSpec[];
  ampKnobs: ReactNode;
  cabKnobs: ReactNode;
  onViewChange: (view: RigMode) => void;
  onPickCombo: (ampId: string) => void;
  onPickHead: (ampId: string) => void;
  onPickCab: (cabId: string) => void;
  onToggleBypass: () => void;
}) {
  const combos = combosIn(amps);
  const heads = headsIn(amps);
  const showingCombo = view === 'combo';
  // In combo view a combo's own speaker replaces the cab picker (mic knobs only).
  const speakerIsBuiltIn = amp.format === 'combo' && speakerOf(amp)?.id === cab.id;

  return (
    <div className="rig-deck">
      <section className="rig-column rig-choose" aria-label="选择音箱">
        <div className="rig-view" role="radiogroup" aria-label="音箱形式">
          {(['combo', 'head'] as const).map((entry) => (
            <button key={entry} type="button" role="radio" aria-checked={view === entry} className={view === entry ? 'active' : ''} onClick={() => onViewChange(entry)}>
              <strong>{entry === 'combo' ? '单体音箱' : '分体音箱'}</strong>
              <small>{entry === 'combo' ? '箱头和喇叭在一个箱子里' : '箱头搭配任意箱体'}</small>
            </button>
          ))}
        </div>
        <div className="model-list" role="radiogroup" aria-label={showingCombo ? '单体音箱' : '箱头'}>
          {(showingCombo ? combos : heads).map((model) => (
            <ModelButton
              key={model.id}
              model={model}
              active={amp.id === model.id}
              marker={isNamAmp(model.id) ? '实采' : undefined}
              onPick={() => (showingCombo ? onPickCombo(model.id) : onPickHead(model.id))}
            />
          ))}
        </div>
      </section>

      <section className="rig-column" aria-label={`${amp.name} 面板`}>
        <div className="section-heading">
          <h3>{amp.name}</h3>
          <button type="button" role="switch" aria-checked={!bypassed} className={'amp-bypass' + (bypassed ? ' active' : '')} onClick={onToggleBypass}>
            {bypassed ? '音箱模拟已关闭' : '音箱模拟已打开'}
          </button>
        </div>
        {ampKnobs}
        <span className="model-method">{amp.modeling}</span>
        <p className="model-description">{amp.description}</p>
      </section>

      <section className="rig-column" aria-label={showingCombo && speakerIsBuiltIn ? '内置喇叭' : '箱体'}>
        {showingCombo && speakerIsBuiltIn ? (
          <div className="section-heading"><h3>内置喇叭</h3><span>{cab.name}</span></div>
        ) : (
          <>
            <div className="section-heading"><h3>箱体</h3><span>{cab.format}</span></div>
            <div className="cab-list" role="radiogroup" aria-label="箱体">
              {cabs.map((model) => <ModelButton key={model.id} model={model} active={cab.id === model.id} onPick={() => onPickCab(model.id)} />)}
            </div>
          </>
        )}
        {cabKnobs}
        <span className="model-method">{cab.modeling}</span>
        <p className="model-description">{cab.description}</p>
        {cab.ir && <p className="model-credit">{cab.ir.credit}</p>}
      </section>
    </div>
  );
}
