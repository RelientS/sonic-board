import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AGENT_REQUEST_COST,
  chargeAgentUse,
  emptyAccountState,
  grantCredits,
  INVITEE_BONUS,
  ledgerBalance,
  MAX_REWARDED_REFERRALS,
  pruneAccountState,
  refundAgentUse,
  REFERRER_REWARD,
  REGISTRATION_WINDOW_MS,
  REGISTRATIONS_PER_IP,
  registerUser,
  SIGNUP_CREDITS,
  type AccountState,
  type IdSource,
} from '../account/accounts.ts';

function sequentialIds(): IdSource {
  let id = 0;
  let code = 0;
  return { newId: () => `id-${++id}`, newReferralCode: () => `code${String(++code).padStart(4, '0')}` };
}

function register(state: AccountState, ids: IdSource, username: string, ipHash: string, referralCode?: string, now = 1_000) {
  const result = registerUser(state, { username, passwordHash: 'hash', ipHash, referralCode }, now, ids);
  if (!result.ok) throw new Error(result.error);
  return result;
}

test('new accounts receive signup credits through the ledger', () => {
  const state = emptyAccountState();
  const { user } = register(state, sequentialIds(), 'alice', 'ip-a');
  assert.equal(user.balance, SIGNUP_CREDITS);
  assert.equal(SIGNUP_CREDITS, 20);
  assert.deepEqual(state.ledger.map((entry) => [entry.type, entry.amount]), [['signup', 20]]);
});

test('usernames are unique case-insensitively', () => {
  const state = emptyAccountState();
  const ids = sequentialIds();
  register(state, ids, 'Alice', 'ip-a');
  assert.deepEqual(registerUser(state, { username: 'alice', passwordHash: 'h', ipHash: 'ip-b' }, 1_000, ids), { ok: false, error: 'username_taken' });
});

test('agent use charges one credit, refunds at most once, and never goes negative', () => {
  const state = emptyAccountState();
  const ids = sequentialIds();
  const { user } = register(state, ids, 'alice', 'ip-a');

  const charged = chargeAgentUse(state, user.id, 'req-1', 2_000, ids);
  assert.deepEqual(charged, { ok: true, balance: SIGNUP_CREDITS - AGENT_REQUEST_COST });
  assert.equal(refundAgentUse(state, user.id, 'req-1', 2_100, ids), true);
  assert.equal(refundAgentUse(state, user.id, 'req-1', 2_200, ids), false, 'double refund is ignored');
  assert.equal(refundAgentUse(state, user.id, 'never-charged', 2_200, ids), false);
  assert.equal(state.users[user.id].balance, SIGNUP_CREDITS);

  for (let index = 0; index < SIGNUP_CREDITS; index += 1) assert.equal(chargeAgentUse(state, user.id, `r${index}`, 3_000, ids).ok, true);
  assert.deepEqual(chargeAgentUse(state, user.id, 'over', 3_000, ids), { ok: false, balance: 0 });
  assert.equal(state.users[user.id].balance, 0);

  grantCredits(state, user.id, 7, 4_000, 'support', ids);
  assert.equal(state.users[user.id].balance, 7);
  assert.throws(() => grantCredits(state, user.id, -8, 4_000, 'too much', ids), /negative/);
  assert.equal(ledgerBalance(state, user.id), state.users[user.id].balance, 'cached balance matches the append-only ledger');
  assert.deepEqual(new Set(state.ledger.map((entry) => entry.type)), new Set(['signup', 'agent_use', 'refund', 'admin_grant']));
});

test('referral link rewards invitee +5 and referrer +15, capped at 10 rewarded referrals', () => {
  const state = emptyAccountState();
  const ids = sequentialIds();
  const { user: referrer } = register(state, ids, 'host', 'ip-host');

  const first = register(state, ids, 'guest0', 'ip-g0', referrer.referralCode);
  assert.equal(first.referralApplied, true);
  assert.equal(first.user.balance, SIGNUP_CREDITS + INVITEE_BONUS);
  assert.equal(first.user.referredBy, referrer.id);
  assert.equal(state.users[referrer.id].balance, SIGNUP_CREDITS + REFERRER_REWARD);

  for (let index = 1; index < MAX_REWARDED_REFERRALS + 3; index += 1) {
    register(state, ids, `guest${index}`, `ip-g${index}`, referrer.referralCode);
  }
  assert.equal(state.users[referrer.id].rewardedReferrals, MAX_REWARDED_REFERRALS);
  assert.equal(state.users[referrer.id].balance, SIGNUP_CREDITS + REFERRER_REWARD * MAX_REWARDED_REFERRALS);
  const late = Object.values(state.users).find((user) => user.username === `guest${MAX_REWARDED_REFERRALS + 2}`);
  assert.equal(late?.balance, SIGNUP_CREDITS + INVITEE_BONUS, 'invitees still get their bonus after the referrer cap');
  assert.equal(ledgerBalance(state, referrer.id), state.users[referrer.id].balance);
});

test('self-referral is impossible: unknown codes and same-network signups earn nothing', () => {
  const state = emptyAccountState();
  const ids = sequentialIds();
  const { user: owner } = register(state, ids, 'owner', 'ip-same');

  const alt = register(state, ids, 'owner-alt', 'ip-same', owner.referralCode);
  assert.equal(alt.referralApplied, false);
  assert.equal(alt.user.balance, SIGNUP_CREDITS);
  assert.equal(state.users[owner.id].balance, SIGNUP_CREDITS);
  assert.equal(state.users[owner.id].rewardedReferrals, 0);

  const ghost = register(state, ids, 'ghost', 'ip-other', 'nosuchcode');
  assert.equal(ghost.referralApplied, false);
  assert.equal(ghost.user.balance, SIGNUP_CREDITS);
});

test('at most 3 registrations per IP within 24 hours', () => {
  const state = emptyAccountState();
  const ids = sequentialIds();
  for (let index = 0; index < REGISTRATIONS_PER_IP; index += 1) register(state, ids, `u${index}`, 'ip-x', undefined, 1_000 + index);
  assert.deepEqual(registerUser(state, { username: 'u9', passwordHash: 'h', ipHash: 'ip-x' }, 2_000, ids), { ok: false, error: 'ip_limit' });
  assert.equal(registerUser(state, { username: 'u9', passwordHash: 'h', ipHash: 'ip-y' }, 2_000, ids).ok, true, 'other IPs unaffected');

  const later = 1_000 + REGISTRATION_WINDOW_MS;
  pruneAccountState(state, later);
  assert.equal(registerUser(state, { username: 'u10', passwordHash: 'h', ipHash: 'ip-x' }, later, ids).ok, true, 'window slides after 24h');
});
