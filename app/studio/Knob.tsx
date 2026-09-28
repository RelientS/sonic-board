'use client';

import { useEffect, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';

import { formatControlValue, type ControlSpec } from '../effects/catalog.ts';
import { getControlHelp, type ControlOwnerKind } from '../effects/control-help.ts';

export type HelpTarget = {
  kind: ControlOwnerKind;
  modelId: string;
  ownerName: string;
  control: ControlSpec;
};

/** Drag distance (px) for the full knob sweep; Shift or a second finger drags 5x finer. */
const KNOB_DRAG_RANGE_PX = 180;
const KNOB_FINE_FACTOR = 5;

function clampKnob(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function knobAngle(value: number) {
  return String(-138 + value * 2.76) + 'deg';
}

/**
 * An editable knob (or two-position switch): drag up/down or left/right,
 * Shift for fine steps, double-click to reset, wheel while focused. The range
 * input stays underneath for keyboard and screen readers.
 */
export function KnobControl({ control, displayLabel, value, disabled, tutorialEnabled, ownerKind, modelId, ownerName, onChange, onHelp }: {
  control: ControlSpec;
  displayLabel?: string;
  value: number;
  disabled: boolean;
  tutorialEnabled: boolean;
  ownerKind: ControlOwnerKind;
  modelId: string;
  ownerName: string;
  onChange: (value: number) => void;
  onHelp: (target: HelpTarget) => void;
}) {
  const input = useRef<HTMLInputElement | null>(null);
  const hit = useRef<HTMLSpanElement | null>(null);
  const drag = useRef<{ pointerId: number; x: number; y: number; start: number; fine: boolean } | null>(null);
  const latest = useRef({ value, onChange });
  useEffect(() => {
    latest.current = { value, onChange };
  });
  const readout = formatControlValue(control, value);
  const label = displayLabel ?? control.label;
  const help = tutorialEnabled && (
    <button
      className="help-trigger"
      type="button"
      aria-label={`查看${ownerName}的${control.label}旋钮说明`}
      onClick={(event) => { event.stopPropagation(); onHelp({ kind: ownerKind, modelId, ownerName, control }); }}
    >?</button>
  );

  // Wheel needs a non-passive listener to stop the page from scrolling, and
  // only acts while the knob has focus so scrolling past a pedal is safe.
  useEffect(() => {
    const element = input.current;
    const target = hit.current;
    if (!element || !target || control.options) return;
    const onWheel = (event: WheelEvent) => {
      if (document.activeElement !== element || element.disabled) return;
      event.preventDefault();
      const step = event.shiftKey ? 0.2 : 1;
      const { value: current, onChange: change } = latest.current;
      const next = clampKnob(current + (event.deltaY < 0 ? step : -step) * Math.max(1, Math.min(5, Math.abs(event.deltaY) / 40)));
      if (next !== current) change(next);
    };
    // The input ignores pointer events, so wheel events land on the wrapper.
    target.addEventListener('wheel', onWheel, { passive: false });
    return () => target.removeEventListener('wheel', onWheel);
  }, [control.options]);

  if (control.options) {
    const on = value >= 50;
    return (
      <div className={'knob-control is-switch' + (tutorialEnabled ? ' is-tutorial' : '')}>
        <span className="knob-label-row"><span className="knob-label">{label}</span>{help}</span>
        <button
          type="button"
          role="switch"
          className="pedal-switch"
          aria-checked={on}
          aria-label={control.label}
          disabled={disabled}
          onClick={() => onChange(on ? 0 : 100)}
        >
          <span className="pedal-switch-lever" aria-hidden="true" />
        </button>
        <span className="knob-readout">{readout}</span>
      </div>
    );
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    input.current?.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, start: value, fine: event.shiftKey };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    // Switching fine mode mid-drag re-anchors so the knob does not jump.
    if (event.shiftKey !== state.fine) {
      Object.assign(state, { x: event.clientX, y: event.clientY, start: value, fine: event.shiftKey });
      return;
    }
    const travel = (state.y - event.clientY) + (event.clientX - state.x);
    const scale = 100 / KNOB_DRAG_RANGE_PX / (state.fine ? KNOB_FINE_FACTOR : 1);
    const next = clampKnob(state.start + travel * scale);
    if (next !== value) onChange(next);
  };
  const endDrag = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (drag.current?.pointerId === event.pointerId) drag.current = null;
  };

  return (
    <div className={'knob-control' + (tutorialEnabled ? ' is-tutorial' : '')}>
      <span className="knob-label-row"><span className="knob-label">{label}</span>{help}</span>
      <span
        ref={hit}
        className={'knob-hit' + (disabled ? ' is-disabled' : '')}
        title="上下或左右拖动调节，Shift 微调，双击复位"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => { if (!disabled) onChange(control.defaultValue); }}
      >
        <span className="knob" style={{ '--angle': knobAngle(value) } as CSSProperties} aria-hidden="true"><span /></span>
        <input
          ref={input}
          type="range"
          min="0"
          max="100"
          step="1"
          value={value}
          disabled={disabled}
          aria-label={control.label}
          aria-valuetext={readout}
          onChange={(event) => onChange(Number(event.target.value))}
        />
      </span>
      <span className="knob-readout">{readout}</span>
    </div>
  );
}

export function ControlHelpDialog({ target, onClose }: { target: HelpTarget | null; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement | null>(null);
  const lesson = target ? getControlHelp(target.kind, target.modelId, target.control) : null;

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (target && !element.open) element.showModal();
    if (!target && element.open) element.close();
  }, [target]);

  return (
    <dialog
      ref={dialog}
      className="control-help-dialog"
      aria-labelledby="control-help-title"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClose={onClose}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      {target && lesson && <div className="help-sheet">
        <header><div><span>{target.ownerName}</span><h2 id="control-help-title">{target.control.label}</h2></div><button type="button" onClick={onClose}>关闭</button></header>
        <div className="help-range"><span>实际范围</span><strong>{lesson.range}</strong></div>
        <p className="help-summary">{lesson.summary}</p>
        <div className="help-directions"><section><span>向左调</span><p>{lesson.low}</p></section><section><span>向右调</span><p>{lesson.high}</p></section></div>
        <div className="help-tip"><span>调音建议</span><p>{lesson.tip}</p></div>
      </div>}
    </dialog>
  );
}
