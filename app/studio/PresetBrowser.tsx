'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import { getAmpSpec } from '../amps/catalog.ts';
import { formatSourceConfig } from '../audio/source-catalog.ts';
import { FACTORY_PRESETS, STYLE_TAG_LABELS, getEffectSearchText, getEffectSpec, getPresetSearchText } from '../effects/catalog.ts';
import type { UserPreset } from '../effects/user-presets.ts';
import { StyleFilters, type StyleFilter } from './studio-shared.tsx';

/**
 * The tone library, opened from the tone name in the top bar: built-in and
 * saved tones, save-as, delete, and reset to the default board.
 */
export function PresetBrowser({ open, activePresetName, userPresets, saveState, onLoadFactory, onLoadUser, onSave, onDelete, onReset, onClose }: {
  open: boolean;
  activePresetName: string;
  userPresets: UserPreset[];
  saveState: 'idle' | 'saved';
  onLoadFactory: (id: string) => void;
  onLoadUser: (preset: UserPreset) => void;
  onSave: (name: string) => void;
  onDelete: (preset: UserPreset) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement | null>(null);
  const [presetSearch, setPresetSearch] = useState('');
  const [styleFilter, setStyleFilter] = useState<StyleFilter>('All');
  const [presetName, setPresetName] = useState('我的音色');

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  const factoryPresetLibrary = useMemo(() => {
    const query = presetSearch.trim().toLowerCase();
    return FACTORY_PRESETS.filter((preset) => {
      const styleMatches = styleFilter === 'All' || preset.styleTags?.includes(styleFilter);
      const queryMatches = !query || getPresetSearchText(preset).toLowerCase().includes(query);
      return styleMatches && queryMatches;
    });
  }, [presetSearch, styleFilter]);

  const userPresetLibrary = useMemo(() => {
    const query = presetSearch.trim().toLowerCase();
    return userPresets.filter((preset) => {
      const effects = preset.chain.map((item) => getEffectSpec(item.specId));
      const styleMatches = styleFilter === 'All' || effects.some((effect) => effect.styleTags?.includes(styleFilter));
      const queryMatches = !query || [preset.name, ...effects.map(getEffectSearchText)].join(' ').toLowerCase().includes(query);
      return styleMatches && queryMatches;
    });
  }, [presetSearch, styleFilter, userPresets]);

  return (
    <dialog
      ref={dialog}
      className="preset-dialog"
      aria-labelledby="preset-title"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClose={onClose}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="preset-sheet">
        <header>
          <div><h2 id="preset-title">音色</h2><p>当前：{activePresetName}</p></div>
          <button type="button" onClick={onClose}>关闭</button>
        </header>
        <form className="preset-editor" onSubmit={(event) => { event.preventDefault(); onSave(presetName); }}>
          <label><span>把当前板存为</span><input value={presetName} maxLength={28} onChange={(event) => setPresetName(event.target.value)} /></label>
          <button type="submit" className="accent">{saveState === 'saved' ? '已保存' : '保存'}</button>
        </form>
        <label className="search preset-search"><span className="sr-only">搜索音色</span><input placeholder="搜索名称、风格或用途" value={presetSearch} onChange={(event) => setPresetSearch(event.target.value)} /></label>
        <StyleFilters value={styleFilter} onChange={setStyleFilter} />
        <div className="preset-scroll">
          <section className="preset-section">
            <h3>我的音色</h3>
            {userPresets.length === 0 ? <p className="preset-empty">还没有保存在本机的音色。调好后在上面起个名字保存。</p> : userPresetLibrary.length === 0 ? <p className="preset-empty">本机音色中没有匹配项。</p> : (
              <div className="preset-list">{userPresetLibrary.map((preset) => {
                const isCurrent = activePresetName === preset.name;
                return <article className={'preset-card user' + (isCurrent ? ' active' : '')} key={preset.id}>
                  <div><strong>{preset.name}</strong><small>{preset.chain.map((item) => getEffectSpec(item.specId).name).join(' → ')}</small><span>{preset.chain.length} 块，{preset.routing.mode === 'parallel' ? '双路并联' : '串联'}，{formatSourceConfig(preset.source)}</span></div>
                  <button type="button" aria-label={'载入 ' + preset.name} aria-current={isCurrent ? 'true' : undefined} onClick={() => onLoadUser(preset)}>载入</button>
                  <button type="button" className="delete-preset" aria-label={'删除' + preset.name} onClick={() => onDelete(preset)}>删除</button>
                </article>;
              })}</div>
            )}
          </section>
          <section className="preset-section">
            <h3>内置音色</h3>
            {factoryPresetLibrary.length === 0 ? <p className="preset-empty">没有匹配这个搜索或风格的内置音色。</p> : (
              <div className="preset-list">{factoryPresetLibrary.map((preset) => {
                const isCurrent = activePresetName === preset.name;
                return <article className={'preset-card' + (isCurrent ? ' active' : '')} key={preset.id}>
                  <div>
                    <strong>{preset.name}</strong><small>{preset.description}</small>
                    <div className="preset-style-tags" role="list" aria-label={`${preset.name} 风格`}>{preset.styleTags?.map((tag) => <span key={tag} role="listitem" title={tag}>{STYLE_TAG_LABELS[tag]}</span>)}</div>
                    <span>{preset.chain.length} 块，{preset.routing.mode === 'parallel' ? '双路并联' : '串联'}，{getAmpSpec(preset.amp.ampId).name}</span>
                  </div>
                  <button type="button" aria-label={'载入 ' + preset.name} aria-current={isCurrent ? 'true' : undefined} onClick={() => onLoadFactory(preset.id)}>载入</button>
                </article>;
              })}</div>
            )}
          </section>
        </div>
        <footer className="preset-footer">
          <button type="button" className="quiet" onClick={onReset}>重置为默认音色</button>
          <small>载入和重置都可以用 ⌘/Ctrl + Z 撤销。</small>
        </footer>
      </div>
    </dialog>
  );
}
