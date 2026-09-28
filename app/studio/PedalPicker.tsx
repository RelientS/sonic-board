'use client';

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import type { SignalLane } from '../audio/audio-core.ts';
import { EFFECT_SPECS, getEffectSearchText, type EffectCategory } from '../effects/catalog.ts';
import { CATEGORY_FILTERS, categoryNames, isCircuitModelled, MiniPedal, StyleFilters, type StyleFilter } from './studio-shared.tsx';

/** Where a picked pedal goes: a chain slot, or into a specific patch cable. */
export type PickerTarget = { lane: SignalLane; index: number; atEnd: boolean; cableLabel?: string };

/**
 * Command-palette pedal picker (⌘/Ctrl+K, the + slots, or "添加效果器"). Type
 * to filter, ↑/↓ to move, Enter to insert at the pending slot.
 */
export function PedalPicker({ open, target, parallel, full, onPick, onClose }: {
  open: boolean;
  target: PickerTarget | null;
  parallel: boolean;
  full: boolean;
  onPick: (specId: string) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement | null>(null);
  const searchInput = useRef<HTMLInputElement | null>(null);
  const list = useRef<HTMLUListElement | null>(null);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<'All' | EffectCategory>('All');
  const [styleFilter, setStyleFilter] = useState<StyleFilter>('All');
  const [circuitOnly, setCircuitOnly] = useState(false);
  const [active, setActive] = useState(0);

  const library = useMemo(() => {
    const query = search.trim().toLowerCase();
    return EFFECT_SPECS.filter((spec) => {
      const categoryMatches = category === 'All' || spec.category === category;
      const styleMatches = styleFilter === 'All' || spec.styleTags?.includes(styleFilter);
      const queryMatches = !query || getEffectSearchText(spec).toLowerCase().includes(query);
      const engineMatches = !circuitOnly || isCircuitModelled(spec.id);
      return categoryMatches && styleMatches && queryMatches && engineMatches;
    });
  }, [category, circuitOnly, search, styleFilter]);
  const highlighted = Math.min(active, Math.max(0, library.length - 1));

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      element.showModal();
      searchInput.current?.focus();
      searchInput.current?.select();
    }
    if (!open && element.open) element.close();
  }, [open]);

  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${highlighted}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [highlighted]);

  function onSearchKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive(Math.min(library.length - 1, highlighted + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive(Math.max(0, highlighted - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const spec = library[highlighted];
      if (spec && !full) onPick(spec.id);
    }
  }

  const where = target?.cableLabel ? `插入到${target.cableLabel}` : !target || target.atEnd
    ? (parallel && target ? `添加到 ${target.lane} 路末尾` : '添加到链的末尾')
    : `插入到${parallel ? `${target.lane} 路` : ''}第 ${target.index + 1} 位`;

  return (
    <dialog
      ref={dialog}
      className="picker-dialog"
      aria-labelledby="picker-title"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClose={onClose}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="picker-sheet">
        <header>
          <div><h2 id="picker-title">添加效果器</h2><p>{where}</p></div>
          <button type="button" onClick={onClose}>关闭</button>
        </header>
        <label className="search picker-search">
          <span className="sr-only">搜索效果器</span>
          <input
            ref={searchInput}
            role="combobox"
            aria-expanded="true"
            aria-controls="picker-results"
            aria-activedescendant={library[highlighted] ? `picker-option-${library[highlighted].id}` : undefined}
            placeholder="搜索名称、类型、风格或用途"
            value={search}
            onChange={(event) => { setSearch(event.target.value); setActive(0); }}
            onKeyDown={onSearchKey}
          />
        </label>
        <div className="filters" aria-label="筛选效果器类型">
          {CATEGORY_FILTERS.map((entry) => <button key={entry} type="button" className={category === entry ? 'active' : ''} aria-pressed={category === entry} onClick={() => { setCategory(entry); setActive(0); }}>{categoryNames[entry]}</button>)}
          <button type="button" className={'circuit-filter' + (circuitOnly ? ' active' : '')} aria-pressed={circuitOnly} title="只看按原厂电路图逐元件仿真的效果器" onClick={() => { setCircuitOnly((current) => !current); setActive(0); }}>电路级</button>
        </div>
        <StyleFilters value={styleFilter} onChange={(value) => { setStyleFilter(value); setActive(0); }} />
        {full && <p className="picker-full" role="alert">板上最多放 16 块效果器，请先移除一块。</p>}
        {library.length === 0 ? <p className="library-empty">没有匹配这个搜索、类型或风格的效果器。</p> : (
          <ul id="picker-results" ref={list} className="picker-results" role="listbox" aria-label="效果器">
            {library.map((spec, index) => (
              <li
                key={spec.id}
                id={`picker-option-${spec.id}`}
                data-index={index}
                role="option"
                aria-selected={index === highlighted}
                aria-disabled={full}
                className={'picker-option' + (index === highlighted ? ' is-active' : '')}
                onPointerMove={() => { if (index !== highlighted) setActive(index); }}
                onClick={() => { if (!full) onPick(spec.id); }}
              >
                <MiniPedal spec={spec} />
                <span className="picker-option-text">
                  <strong>{spec.name}{isCircuitModelled(spec.id) && <em className="circuit-badge" title="按原厂电路图逐元件仿真（SPICE 校验）">CIRCUIT</em>}</strong>
                  <small>{categoryNames[spec.category]}，{spec.family}</small>
                  <span>{spec.description}</span>
                </span>
                {spec.nam && <em className="picker-nam">需要本机 NAM 模型</em>}
              </li>
            ))}
          </ul>
        )}
        <p className="classic-note">经典名称仅用于说明参考对象；模型通过自动门禁，待真机验证。<a href="https://github.com/RelientS/sonic-board" target="_blank" rel="noreferrer">源码与验证说明</a></p>
      </div>
    </dialog>
  );
}
