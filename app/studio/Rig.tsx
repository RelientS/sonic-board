'use client';

import { forwardRef, useEffect, useRef, type CSSProperties, type ReactNode } from 'react';

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
export const RigObject = forwardRef<HTMLButtonElement, {
  amp: AmpSpec;
  cab: CabSpec;
  bypassed: boolean;
  lit: boolean;
  expanded: boolean;
  onOpen: () => void;
}>(function RigObject({ amp, cab, bypassed, lit, expanded, onOpen }, ref) {
  const combo = amp.format === 'combo' && amp.speakerCab === cab.id;
  const speakers = speakerCount(cab);
  const style = { '--amp-plate': amp.finish, '--amp-logo': amp.accent } as CSSProperties;
  const label = `音箱：${amp.name}${combo ? '（单体）' : `，箱体 ${cab.name}`}${bypassed ? '，已旁通' : ''}。打开音箱设置`;
  return (
    <button
      ref={ref}
      type="button"
      className={'rig-object' + (combo ? ' is-combo' : ' is-stack') + (bypassed ? ' is-bypassed' : '') + (lit ? ' is-lit' : '')}
      style={style}
      aria-label={label}
      aria-expanded={expanded}
      aria-controls="rig-drawer"
      onClick={onOpen}
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
});

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
 * Side sheet (bottom sheet on phones) for the amp section. Non-modal: the
 * board stays usable, Escape and the close button return focus to the rig.
 */
export function RigDrawer({
  open, view, amps, amp, cab, bypassed, cabs, ampKnobs, cabKnobs,
  onViewChange, onPickCombo, onPickHead, onPickCab, onToggleBypass, onClose,
}: {
  open: boolean;
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
  onClose: () => void;
}) {
  const heading = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    if (!open) return;
    heading.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  const combos = combosIn(amps);
  const heads = headsIn(amps);
  const showingCombo = view === 'combo';
  // In combo view a combo's own speaker replaces the cab picker (mic knobs only).
  const speakerIsBuiltIn = amp.format === 'combo' && speakerOf(amp)?.id === cab.id;

  return (
    <aside id="rig-drawer" className="rig-drawer" aria-labelledby="rig-drawer-title">
      <header>
        <h2 id="rig-drawer-title" ref={heading} tabIndex={-1}>音箱</h2>
        <button type="button" className="rig-close" onClick={onClose}>关闭</button>
      </header>
      <div className="rig-drawer-body">
        <button
          type="button"
          className={'amp-bypass' + (bypassed ? ' active' : '')}
          aria-pressed={bypassed}
          onClick={onToggleBypass}
        >{bypassed ? '音箱模拟已关闭，点这里打开' : '音箱模拟已打开'}</button>
        <div className="rig-view" role="radiogroup" aria-label="音箱形式">
          {(['combo', 'head'] as const).map((entry) => (
            <button key={entry} type="button" role="radio" aria-checked={view === entry} className={view === entry ? 'active' : ''} onClick={() => onViewChange(entry)}>
              <strong>{entry === 'combo' ? '单体音箱' : '分体音箱'}</strong>
              <small>{entry === 'combo' ? '箱头和喇叭在一个箱子里' : '箱头搭配任意箱体'}</small>
            </button>
          ))}
        </div>

        <section className="output-section">
          <div className="section-heading"><h3>{showingCombo ? '选择音箱' : '选择箱头'}</h3></div>
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

        <section className="output-section">
          <div className="section-heading"><h3>面板</h3><span>{amp.name}</span></div>
          <span className="model-method">{amp.modeling}</span>
          <p className="model-description">{amp.description}</p>
          {ampKnobs}
        </section>

        <section className="output-section cab-section">
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
          <span className="model-method">{cab.modeling}</span>
          <p className="model-description">{cab.description}</p>
          {cab.ir && <p className="model-credit">{cab.ir.credit}</p>}
          {cabKnobs}
        </section>
      </div>
    </aside>
  );
}
