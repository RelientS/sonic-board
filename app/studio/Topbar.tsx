'use client';

import Link from 'next/link';
import { useEffect, useRef } from 'react';

import { AccountButton } from '../account/AccountButton.tsx';
import { SHORTCUT_HELP } from './shortcuts.ts';

function ShortcutsPopover({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const root = useRef<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) onOpenChange(false); };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onOpenChange(false);
      trigger.current?.focus();
    };
    window.addEventListener('pointerdown', onPointer);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open, onOpenChange]);

  return (
    <div className="shortcuts" ref={root}>
      <button ref={trigger} type="button" className="icon-button" aria-label="快捷键" title="快捷键（?）" aria-expanded={open} aria-controls="shortcuts-popover" onClick={() => onOpenChange(!open)}>⌨</button>
      {open && (
        <div id="shortcuts-popover" className="shortcuts-popover" role="dialog" aria-label="快捷键">
          <h2>快捷键</h2>
          <dl>
            {SHORTCUT_HELP.map((entry) => <div key={entry.keys}><dt><kbd>{entry.keys}</kbd></dt><dd>{entry.action}</dd></div>)}
          </dl>
        </div>
      )}
    </div>
  );
}

export function Topbar({
  activePresetName, canUndo, canRedo, agentOpen, tutorialEnabled, presetOpen, shortcutsOpen,
  onOpenPresets, onUndo, onRedo, onAddPedal, onToggleAgent, onTutorialChange, onShortcutsOpenChange, onAccountChange,
}: {
  activePresetName: string;
  canUndo: boolean;
  canRedo: boolean;
  agentOpen: boolean;
  tutorialEnabled: boolean;
  presetOpen: boolean;
  shortcutsOpen: boolean;
  onOpenPresets: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onAddPedal: () => void;
  onToggleAgent: () => void;
  onTutorialChange: (enabled: boolean) => void;
  onShortcutsOpenChange: (open: boolean) => void;
  onAccountChange: () => void;
}) {
  return (
    <header className="topbar">
      <Link className="brand" href="/" aria-label="Sonic Board 首页"><span className="brand-mark" aria-hidden="true"><i /></span><strong>Sonic Board</strong></Link>
      <button type="button" className="tone-button" aria-haspopup="dialog" aria-expanded={presetOpen} aria-label={`当前音色：${activePresetName}。打开音色库`} onClick={onOpenPresets}>
        <small>当前音色</small><strong>{activePresetName}</strong><i aria-hidden="true">▾</i>
      </button>
      <div className="history-actions">
        <button type="button" aria-label="撤销" title="撤销（⌘/Ctrl+Z）" disabled={!canUndo} onClick={onUndo}>↶</button>
        <button type="button" aria-label="重做" title="重做（⇧⌘/Ctrl+Shift+Z）" disabled={!canRedo} onClick={onRedo}>↷</button>
      </div>
      <div className="top-actions">
        <button type="button" className="add-pedal-button" title="添加效果器（⌘/Ctrl + K）" onClick={onAddPedal}><span aria-hidden="true">+</span>添加效果器</button>
        <button
          type="button"
          className={'agent-open-button' + (agentOpen ? ' active' : '')}
          aria-label={agentOpen ? '关闭音色 Agent' : '打开音色 Agent'}
          aria-controls="tone-agent-dock"
          aria-expanded={agentOpen}
          onClick={onToggleAgent}
        >音色 Agent</button>
        <label className="tutorial-toggle">
          <input
            type="checkbox"
            role="switch"
            checked={tutorialEnabled}
            aria-label="参数教程"
            onChange={(event) => onTutorialChange(event.target.checked)}
          />
          <i aria-hidden="true"><b /></i><strong>参数教程</strong>
        </label>
        <ShortcutsPopover open={shortcutsOpen} onOpenChange={onShortcutsOpenChange} />
        <AccountButton onAccountChange={onAccountChange} />
      </div>
    </header>
  );
}
