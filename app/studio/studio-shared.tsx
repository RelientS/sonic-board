'use client';

import type { CSSProperties } from 'react';

import { STYLE_TAGS, STYLE_TAG_LABELS, type EffectCategory, type EffectSpec, type StyleTag } from '../effects/catalog.ts';
import { getEffectFidelity } from '../effects/fidelity.ts';

export type StyleFilter = 'All' | StyleTag;

export const categoryNames: Record<'All' | EffectCategory, string> = {
  All: '全部',
  Dynamics: '动态',
  Tone: '音色',
  Drive: '增益',
  Mod: '调制',
  Delay: '延迟',
  Space: '空间',
};

export const CATEGORY_FILTERS = ['All', 'Dynamics', 'Tone', 'Drive', 'Mod', 'Delay', 'Space'] as const;

export function isCircuitModelled(effectId: string) {
  return getEffectFidelity(effectId)?.runtime === 'circuit';
}

export function isWidePedal(spec: EffectSpec) {
  return Boolean(spec.wide) || spec.controls.length > 4;
}

/** A thumbnail of the pedal's enclosure (library, picker, mobile rows). */
export function MiniPedal({ spec, size = 'small' }: { spec: EffectSpec; size?: 'small' | 'large' }) {
  const style = { '--finish': spec.finish, '--ink': spec.ink } as CSSProperties;
  return <span className={'mini-pedal' + (isWidePedal(spec) ? ' is-wide' : '') + (size === 'large' ? ' is-large' : '')} style={style} aria-hidden="true"><i /><i /><i /><b /></span>;
}

export function StyleFilters({ value, onChange }: { value: StyleFilter; onChange: (value: StyleFilter) => void }) {
  return (
    <div className="style-filters" role="group" aria-label="按风格筛选">
      <button type="button" className={value === 'All' ? 'active' : ''} aria-pressed={value === 'All'} onClick={() => onChange('All')}><span>全部</span><small>All</small></button>
      {STYLE_TAGS.map((tag) => (
        <button key={tag} type="button" className={value === tag ? 'active' : ''} aria-pressed={value === tag} onClick={() => onChange(tag)}>
          <span>{STYLE_TAG_LABELS[tag]}</span><small>{tag}</small>
        </button>
      ))}
    </div>
  );
}

/** Moves focus to a board node once React has rendered it. */
export function focusNodeElement(id: string) {
  window.requestAnimationFrame(() => {
    const element = document.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(id)}"]`);
    element?.focus({ preventScroll: false });
  });
}
