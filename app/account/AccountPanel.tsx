'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, Copy, Gift, LogOut, UserRound } from 'lucide-react';

import { PENDING_REFERRAL_STORAGE_KEY, REFERRAL_RULE_TEXT, referralLink, type AccountSummary } from './shared.ts';
import './account.css';

export type AccountState =
  | { status: 'loading'; account?: undefined }
  | { status: 'anonymous'; account?: undefined }
  | { status: 'ready'; account: AccountSummary };

type AuthMode = 'login' | 'register';

function readPendingReferral() {
  try {
    return window.sessionStorage.getItem(PENDING_REFERRAL_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

/** Captures `?ref=` from the landing URL once so it survives until registration. */
function capturePendingReferral() {
  try {
    const ref = new URLSearchParams(window.location.search).get('ref')?.trim().toLowerCase();
    if (ref && /^[a-z0-9]{4,16}$/.test(ref)) window.sessionStorage.setItem(PENDING_REFERRAL_STORAGE_KEY, ref);
  } catch {
    // Storage can be unavailable (private mode); referral is best-effort.
  }
}

async function postJson(url: string, body: unknown) {
  const response = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({})) as { error?: string; account?: AccountSummary | null };
  return { ok: response.ok, status: response.status, payload };
}

async function fetchAccountState(): Promise<AccountState | null> {
  try {
    const response = await fetch('/api/account/me', { credentials: 'same-origin', cache: 'no-store' });
    const payload = await response.json() as { account?: AccountSummary | null };
    return payload.account ? { status: 'ready', account: payload.account } : { status: 'anonymous' };
  } catch {
    return null;
  }
}

/** Account session state for the Tone Agent dock; refreshes when the dock opens and after each agent run. */
export function useAccount(open: boolean, busy: boolean) {
  const [state, setState] = useState<AccountState>({ status: 'loading' });

  const refresh = useCallback(() => fetchAccountState().then((next) => {
    setState((current) => next ?? (current.status === 'loading' ? { status: 'anonymous' } : current));
  }), []);

  useEffect(() => {
    capturePendingReferral();
  }, []);

  // Refresh when the dock opens and whenever an agent run finishes (credits changed).
  const shouldRefresh = open && !busy;
  useEffect(() => {
    if (!shouldRefresh) return;
    let active = true;
    void fetchAccountState().then((next) => {
      if (!active) return;
      setState((current) => next ?? (current.status === 'loading' ? { status: 'anonymous' } : current));
    });
    return () => {
      active = false;
    };
  }, [shouldRefresh]);

  const authenticate = useCallback(async (mode: AuthMode, username: string, password: string) => {
    const ref = mode === 'register' ? readPendingReferral() : '';
    try {
      const result = await postJson(`/api/account/${mode}`, ref ? { username, password, ref } : { username, password });
      if (!result.ok || !result.payload.account) return result.payload.error || '操作失败，请稍后再试。';
      if (mode === 'register') {
        try {
          window.sessionStorage.removeItem(PENDING_REFERRAL_STORAGE_KEY);
        } catch {
          // Ignore storage errors.
        }
      }
      setState({ status: 'ready', account: result.payload.account });
      return '';
    } catch {
      return '网络异常，请稍后再试。';
    }
  }, []);

  const logout = useCallback(async () => {
    await postJson('/api/account/logout', {}).catch(() => undefined);
    setState({ status: 'anonymous' });
  }, []);

  return { state, refresh, authenticate, logout };
}

export type AccountController = ReturnType<typeof useAccount>;

export function AccountPanel({ controller, shareOpen, onShareOpenChange }: {
  controller: AccountController;
  shareOpen: boolean;
  onShareOpenChange: (open: boolean) => void;
}) {
  const { state } = controller;
  if (state.status === 'loading') return <div className="account-panel is-loading" aria-busy="true">正在读取账号…</div>;
  if (state.status === 'anonymous') return <AuthForm controller={controller} />;
  return <AccountBar account={state.account} controller={controller} shareOpen={shareOpen || state.account.credits <= 0} onShareOpenChange={onShareOpenChange} />;
}

function AuthForm({ controller }: { controller: AccountController }) {
  const [mode, setMode] = useState<AuthMode>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  // Only rendered client-side after the session check, so storage is readable here.
  const [pendingRef] = useState(readPendingReferral);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError('');
    const message = await controller.authenticate(mode, username.trim(), password);
    setPending(false);
    if (message) setError(message);
    else setPassword('');
  }

  return (
    <form className="account-panel account-auth" onSubmit={(event) => void submit(event)} aria-label={mode === 'login' ? '登录' : '注册'}>
      <div className="account-auth-head">
        <span><UserRound size={13} aria-hidden="true" />{mode === 'login' ? '登录后使用音色 Agent' : '注册即送 20 次'}</span>
        <div className="account-tabs" role="tablist" aria-label="登录或注册">
          {(['login', 'register'] as const).map((entry) => <button
            key={entry}
            type="button"
            role="tab"
            aria-selected={mode === entry}
            className={mode === entry ? 'active' : ''}
            onClick={() => { setMode(entry); setError(''); }}
          >{entry === 'login' ? '登录' : '注册'}</button>)}
        </div>
      </div>
      <div className="account-fields">
        <input
          aria-label="用户名"
          name="username"
          autoComplete="username"
          placeholder="用户名"
          minLength={3}
          maxLength={24}
          pattern="[A-Za-z0-9_\-]{3,24}"
          required
          value={username}
          onChange={(event) => setUsername(event.target.value)}
        />
        <input
          aria-label="密码"
          name="password"
          type="password"
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          placeholder={mode === 'login' ? '密码' : '密码（至少 8 位）'}
          minLength={mode === 'register' ? 8 : undefined}
          maxLength={128}
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <button type="submit" disabled={pending}>{pending ? '请稍候…' : mode === 'login' ? '登录' : '注册'}</button>
      </div>
      {mode === 'register' && <small className="account-hint">
        用户名 3–24 位字母、数字、_ 或 -。{pendingRef ? '你来自好友的邀请链接，注册额外 +5 次。' : ''}
      </small>}
      {error && <div className="account-error" role="alert">{error}</div>}
    </form>
  );
}

function AccountBar({ account, controller, shareOpen, onShareOpenChange }: {
  account: AccountSummary;
  controller: AccountController;
  shareOpen: boolean;
  onShareOpenChange: (open: boolean) => void;
}) {
  const [copied, setCopied] = useState(false);
  const linkInput = useRef<HTMLInputElement>(null);
  const link = referralLink(account.referralCode);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1_600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      linkInput.current?.select();
    }
  }

  const empty = account.credits <= 0;
  return (
    <div className={`account-panel account-bar${empty ? ' is-empty' : ''}`}>
      <div className="account-bar-row">
        <span className="account-user"><UserRound size={12} aria-hidden="true" /><b>{account.username}</b></span>
        <span className="account-credits" role="status" aria-live="polite">剩余 <b>{account.credits}</b> 次</span>
        <button type="button" aria-expanded={shareOpen} onClick={() => onShareOpenChange(!shareOpen)}><Gift size={12} aria-hidden="true" />分享得次数</button>
        <button type="button" aria-label="退出登录" title="退出登录" onClick={() => void controller.logout()}><LogOut size={12} aria-hidden="true" /></button>
      </div>
      {shareOpen && <div className="account-share">
        {empty && <p className="account-empty">免费次数已用完，邀请朋友注册即可继续使用。</p>}
        <div className="account-share-link">
          <input ref={linkInput} readOnly aria-label="我的邀请链接" value={link} onFocus={(event) => event.currentTarget.select()} />
          <button type="button" onClick={() => void copyLink()}>{copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}{copied ? '已复制' : '复制'}</button>
        </div>
        <small>{REFERRAL_RULE_TEXT}（已奖励 {account.rewardedReferrals}/{account.maxRewardedReferrals}）</small>
      </div>}
    </div>
  );
}
