'use client';

import { useEffect, useRef, type KeyboardEvent } from 'react';
import {
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  CircleDot,
  History,
  RotateCcw,
  SlidersHorizontal,
  Square,
  Wrench,
  X,
} from 'lucide-react';

import { getEffectSpec } from '../effects/catalog.ts';
import type { ToneAgentAction, ToneAgentTraceStep } from './tone-agent-runtime.ts';

export type ToneAgentTurn = {
  id: string;
  userMessage: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  streamingMessage?: string;
  message?: string;
  trace: ToneAgentTraceStep[];
  actions: ToneAgentAction[];
  appliedCount?: number;
  applyErrors?: string[];
  undone?: boolean;
};

const quickPrompts = [
  '先读取当前音色，告诉我这条链的结构和主要问题',
  '把现在的音墙调得更厚，但保住中频和弦轮廓',
  '教我当前选中效果器每个旋钮应该怎么听',
  '做一条有慢相位、毛刺不强的绵密盯鞋音色',
];

export function ToneAgentDock({
  open,
  input,
  turns,
  busy,
  error,
  boardSummary,
  onOpenChange,
  onInputChange,
  onSubmit,
  onStop,
  onUndo,
  onClear,
}: {
  open: boolean;
  input: string;
  turns: ToneAgentTurn[];
  busy: boolean;
  error: string;
  boardSummary: string;
  onOpenChange: (open: boolean) => void;
  onInputChange: (input: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  onUndo: (turnId: string) => void;
  onClear: () => void;
}) {
  const thread = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const dock = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open || !thread.current) return;
    thread.current.scrollTop = thread.current.scrollHeight;
  }, [open, turns]);

  useEffect(() => {
    if (!open) return;
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => closeButton.current?.focus());
    const parent = dock.current?.parentElement;
    const background = parent
      ? Array.from(parent.children).filter((element): element is HTMLElement => element instanceof HTMLElement && element !== dock.current)
      : [];
    const inertState = background.map((element) => {
      const withInert = element as HTMLElement & { inert: boolean };
      const previous = withInert.inert;
      withInert.inert = true;
      return { element: withInert, previous };
    });
    function containFocus(event: globalThis.KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onOpenChange(false);
    }
    document.addEventListener('keydown', containFocus);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', containFocus);
      inertState.forEach(({ element, previous }) => { element.inert = previous; });
      if (returnFocus?.isConnected) window.requestAnimationFrame(() => returnFocus.focus());
    };
  }, [open, onOpenChange]);

  function trapTab(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== 'Tab' || !dock.current) return;
    const focusable = Array.from(dock.current.querySelectorAll<HTMLElement>(
      'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [href], summary, [contenteditable="true"], [tabindex]:not([tabindex="-1"])',
    ));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!dock.current.contains(document.activeElement)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  if (!open) return null;
  return (
    <aside id="tone-agent-dock" ref={dock} className="tone-agent-dock" role="dialog" aria-modal="true" aria-labelledby="tone-agent-title" onKeyDown={trapTab}>
      <header className="tone-agent-header">
        <div className="tone-agent-title">
          <span className="tone-agent-mark"><Bot size={17} aria-hidden="true" /></span>
          <span><strong id="tone-agent-title">音色 Agent</strong><small>Pi Agent · gpt-5.6-terra</small></span>
        </div>
        <div className="tone-agent-header-actions">
          {turns.length > 0 && <button type="button" aria-label="清空 Agent 对话" title="清空对话" disabled={busy} onClick={onClear}><History size={15} aria-hidden="true" /></button>}
          <button ref={closeButton} type="button" aria-label="关闭音色 Agent" onClick={() => onOpenChange(false)}><X size={17} aria-hidden="true" /></button>
        </div>
      </header>

      <div className="tone-agent-context" title={boardSummary}>
        <CircleDot size={11} aria-hidden="true" /><span>已连接当前板面</span><b>{boardSummary}</b>
      </div>

      <div className="tone-agent-thread" ref={thread} role="log" aria-live="polite" aria-label="Agent 对话与工具调用">
        <section className="tone-agent-intro">
          <div className="tone-agent-intro-icon"><SlidersHorizontal size={20} aria-hidden="true" /></div>
          <h2>问音色，也可以直接让我调</h2>
          <p>我能读取当前链路和真实参数，调用站内工具调整效果器、输入、串并联、箱头箱体和输出；也能解释为什么这么调。</p>
          {turns.length === 0 && <div className="tone-agent-quick" aria-label="常用问题">
            {quickPrompts.map((prompt) => <button type="button" key={prompt} onClick={() => onInputChange(prompt)}>{prompt}</button>)}
          </div>}
        </section>

        {turns.map((turn) => {
          const message = turn.message || turn.streamingMessage;
          return <article className={`tone-agent-turn is-${turn.status}`} key={turn.id}>
            <div className="tone-agent-user"><p>{turn.userMessage}</p></div>
            {turn.status === 'running' && !turn.trace.length && !message && <div className="tone-agent-working" role="status"><i aria-hidden="true" />正在理解问题并选择站内工具…</div>}
            {turn.trace.length > 0 && <details className="tone-agent-trace" open={turn.status === 'running'}>
              <summary><Wrench size={12} aria-hidden="true" /><span>工具调用</span><b>{turn.trace.filter((step) => step.kind !== 'tool-result').length}</b><ChevronDown size={13} aria-hidden="true" /></summary>
              <ol>{turn.trace.map((step) => <li className={step.status === 'failed' ? 'is-failed' : ''} key={step.id}>
                {step.status === 'completed' ? <Check size={11} aria-hidden="true" /> : <X size={11} aria-hidden="true" />}
                <span><strong>{step.title}</strong><small>{step.detail}</small></span>
                {step.toolName && <code>{step.toolName}</code>}
              </li>)}</ol>
            </details>}
            {message && <div className="tone-agent-assistant"><span>Agent</span><p>{message}</p></div>}
            {turn.appliedCount ? <div className="tone-agent-applied" role="status">
              <span><Check size={12} aria-hidden="true" />已应用 {turn.appliedCount} 项调整</span>
              {!turn.undone && <button type="button" onClick={() => onUndo(turn.id)}><RotateCcw size={12} aria-hidden="true" />撤销</button>}
              {turn.undone && <b>已撤销</b>}
            </div> : null}
            {turn.actions.length > 0 && <details className="tone-agent-actions">
              <summary>查看本次调整</summary>
              <ol>{turn.actions.map((action, index) => <li key={`${turn.id}-${index}`}>{actionLabel(action)}</li>)}</ol>
            </details>}
            {turn.applyErrors?.length ? <div className="tone-agent-inline-error" role="alert">{turn.applyErrors.join('；')}</div> : null}
            {turn.status === 'cancelled' && <div className="tone-agent-cancelled"><Square size={9} fill="currentColor" aria-hidden="true" />已中断</div>}
          </article>;
        })}
        {error && <div className="tone-agent-error" role="alert">{error}</div>}
      </div>

      <form className="tone-agent-composer" onSubmit={(event) => { event.preventDefault(); if (busy) onStop(); else onSubmit(); }}>
        <label htmlFor="tone-agent-input">和音色 Agent 对话</label>
        <div>
          <textarea
            id="tone-agent-input"
            value={input}
            maxLength={2_000}
            placeholder="问一个问题，或描述想怎么调整当前音色…"
            onChange={(event) => onInputChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
              event.preventDefault();
              if (busy) onStop(); else onSubmit();
            }}
          />
          <button type="submit" className={busy ? 'is-stop' : ''} aria-label={busy ? '中断 Agent' : '发送给 Agent'} disabled={!busy && !input.trim()}>
            {busy ? <Square size={13} fill="currentColor" aria-hidden="true" /> : <ArrowUp size={16} aria-hidden="true" />}
          </button>
        </div>
        <small>Enter 发送 · Shift + Enter 换行 · 调整后可撤销</small>
      </form>
    </aside>
  );
}

function actionLabel(action: ToneAgentAction) {
  if (action.type === 'replace_board') return `重建音色：${action.name}`;
  if (action.type === 'update_effect') return `调节 ${action.instanceId}：${Object.keys(action.values).join(' / ')}`;
  if (action.type === 'add_effect') return `添加 ${getEffectSpec(action.specId).name}`;
  if (action.type === 'remove_effect') return `移除 ${action.instanceId}`;
  if (action.type === 'move_effect') return `移动 ${action.instanceId} 到第 ${action.position + 1} 位`;
  if (action.type === 'set_bypass') return `${action.bypassed ? '旁通' : '启用'} ${action.instanceId}`;
  if (action.type === 'set_routing') return `切换为${action.routing.mode === 'parallel' ? '双路并联' : '串联'}`;
  if (action.type === 'set_amp_cab') return `设置箱头 / 箱体：${action.amp.ampId} / ${action.amp.cabId}`;
  if (action.type === 'set_source') return `设置清音输入：${action.source.guitar} / ${action.source.performance}`;
  if (action.type === 'set_output') return `总输出调至 ${action.value}`;
  return `监听切换为${action.mode === 'wet' ? '效果声' : '干声'}`;
}
