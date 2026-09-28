/**
 * The studio keyboard map, as a pure function of the key event and where the
 * focus is, so it can be tested without a DOM.
 */
export type Shortcut =
  | { type: 'play' }
  | { type: 'bypass' }
  | { type: 'focusPrev' }
  | { type: 'focusNext' }
  | { type: 'movePrev' }
  | { type: 'moveNext' }
  | { type: 'focusIndex'; index: number }
  | { type: 'picker' }
  | { type: 'remove' }
  | { type: 'close' }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'dryHold' }
  | { type: 'help' };

export type KeyInput = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
};

/**
 * Where the key was pressed: typing in a text field, on a knob/slider (whose
 * arrow keys adjust the value), or anywhere else. A modal (picker, preset
 * browser, help) handles its own keys.
 */
export type KeyContext = { target: 'text' | 'range' | 'other'; modalOpen: boolean };

export const SHORTCUT_HELP: Array<{ keys: string; action: string }> = [
  { keys: 'Space', action: '播放 / 停止' },
  { keys: '按住 D', action: '临时听干声' },
  { keys: '← / →', action: '上一个 / 下一个' },
  { keys: 'Alt + ← / →', action: '把当前单块前移 / 后移' },
  { keys: '1 – 9', action: '跳到第 N 个' },
  { keys: 'B', action: '旁通 / 启用当前单块' },
  { keys: 'Delete', action: '移除当前单块' },
  { keys: '⌘ / Ctrl + K', action: '添加效果器' },
  { keys: '⌘ / Ctrl + Z', action: '撤销（加 Shift 重做）' },
  { keys: 'Esc', action: '收起面板' },
  { keys: '?', action: '显示快捷键' },
];

export function shortcutFor(event: KeyInput, context: KeyContext): Shortcut | null {
  if (context.modalOpen || context.target === 'text') return null;
  const key = event.key;
  const lower = key.length === 1 ? key.toLowerCase() : key;
  if (event.metaKey || event.ctrlKey) {
    if (event.altKey) return null;
    if (lower === 'k') return { type: 'picker' };
    if (lower === 'z' && !event.shiftKey) return { type: 'undo' };
    if (lower === 'z' || lower === 'y') return { type: 'redo' };
    return null;
  }
  if (key === 'Escape') return { type: 'close' };
  if (key === ' ' || key === 'Spacebar') return event.repeat ? null : { type: 'play' };
  // On a knob or slider the arrows (and editing keys) belong to the control.
  if (context.target === 'range') return null;
  if (key === 'ArrowLeft') return event.altKey ? { type: 'movePrev' } : { type: 'focusPrev' };
  if (key === 'ArrowRight') return event.altKey ? { type: 'moveNext' } : { type: 'focusNext' };
  if (event.altKey) return null;
  if (key === 'Delete' || key === 'Backspace') return { type: 'remove' };
  if (key === '?') return { type: 'help' };
  if (event.shiftKey) return null;
  if (lower === 'b') return { type: 'bypass' };
  if (lower === 'd') return event.repeat ? null : { type: 'dryHold' };
  if (/^[1-9]$/.test(key)) return { type: 'focusIndex', index: Number(key) - 1 };
  return null;
}

/** Classifies a key event target for `shortcutFor`. */
export function keyTargetOf(target: EventTarget | null): KeyContext['target'] {
  const element = target as HTMLElement | null;
  if (!element || typeof element.closest !== 'function') return 'other';
  if (element.closest('textarea, select, [contenteditable="true"], input:not([type="range"]):not([type="checkbox"]):not([type="radio"]):not([type="file"])')) return 'text';
  if (element.closest('input[type="range"]')) return 'range';
  return 'other';
}
