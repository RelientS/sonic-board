'use client';

import { useEffect, useRef, useState } from 'react';

import { AccountPanel, useAccount } from './AccountPanel.tsx';

/** Top-bar entry to sign in or register without opening the tone agent. */
export function AccountButton({ onAccountChange }: { onAccountChange?: () => void }) {
  const [open, setOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  // Checks the session once on load; opening the dialog refreshes it (the
  // agent dock keeps its own copy, which may have signed in meanwhile).
  const account = useAccount(true, false);
  const dialog = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  const signedIn = account.state.status === 'ready' ? account.state.account.username : null;
  // Owner-only features (private amp captures) depend on who is signed in.
  const changed = useRef(onAccountChange);
  useEffect(() => {
    changed.current = onAccountChange;
  });
  useEffect(() => {
    if (account.state.status !== 'loading') changed.current?.();
  }, [signedIn, account.state.status]);
  return (
    <>
      <button type="button" className="quiet account-open-button" aria-haspopup="dialog" onClick={() => { setOpen(true); void account.refresh(); }}>{signedIn ?? <><span className="account-label-long">登录 / 注册</span><span className="account-label-short">登录</span></>}</button>
      <dialog
        ref={dialog}
        className="account-dialog"
        aria-label="账号"
        onCancel={(event) => { event.preventDefault(); setOpen(false); }}
        onClose={() => setOpen(false)}
        onClick={(event) => { if (event.target === event.currentTarget) setOpen(false); }}
      >
        <div className="account-dialog-sheet">
          <header><h2>账号</h2><button type="button" onClick={() => setOpen(false)}>关闭</button></header>
          <AccountPanel controller={account} shareOpen={shareOpen} onShareOpenChange={setShareOpen} />
        </div>
      </dialog>
    </>
  );
}
