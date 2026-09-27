// Pure account/credit domain logic. Every function here operates on an
// in-memory `AccountState` so it can be unit-tested without a server or disk;
// persistence and locking live in `store.ts`.
import { nodeCrypto } from './node-builtins.ts';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from './password.ts';
import { SESSION_TTL_MS } from './session.ts';

export const SIGNUP_CREDITS = 20;
export const INVITEE_BONUS = 5;
export const REFERRER_REWARD = 15;
export const MAX_REWARDED_REFERRALS = 10;
export const AGENT_REQUEST_COST = 1;
export const REGISTRATIONS_PER_IP = 3;
export const REGISTRATION_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Append-only ledger. Paid top-ups can later add e.g. a `purchase` type without migrating data. */
export type LedgerType = 'signup' | 'referral' | 'agent_use' | 'refund' | 'admin_grant';

export type LedgerEntry = {
  id: string;
  userId: string;
  type: LedgerType;
  amount: number;
  at: number;
  /** Related object: request id for agent_use/refund, the other user id for referral. */
  ref?: string;
  note?: string;
};

export type UserRecord = {
  id: string;
  username: string;
  usernameKey: string;
  passwordHash: string;
  referralCode: string;
  referredBy?: string;
  rewardedReferrals: number;
  /** Cached sum of this user's ledger entries; `ledgerBalance` recomputes it for audits. */
  balance: number;
  createdAt: number;
  signupIpHash: string;
};

export type SessionRecord = { userId: string; createdAt: number; expiresAt: number };
export type RegistrationRecord = { ipHash: string; at: number };

export type AccountState = {
  version: 1;
  users: Record<string, UserRecord>;
  sessions: Record<string, SessionRecord>;
  ledger: LedgerEntry[];
  registrations: RegistrationRecord[];
};

export type PublicAccount = {
  username: string;
  credits: number;
  referralCode: string;
  rewardedReferrals: number;
  maxRewardedReferrals: number;
};

export type IdSource = { newId: () => string; newReferralCode: () => string };

const REFERRAL_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export const defaultIds: IdSource = {
  newId: () => nodeCrypto().randomUUID(),
  newReferralCode: () => {
    const bytes = nodeCrypto().randomBytes(8);
    return Array.from(bytes, (byte) => REFERRAL_ALPHABET[byte % REFERRAL_ALPHABET.length]).join('');
  },
};

export function emptyAccountState(): AccountState {
  return { version: 1, users: {}, sessions: {}, ledger: [], registrations: [] };
}

export function normalizeUsername(value: unknown) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{3,24}$/.test(value) ? value : null;
}

export function isValidPassword(value: unknown): value is string {
  return typeof value === 'string' && value.length >= PASSWORD_MIN_LENGTH && value.length <= PASSWORD_MAX_LENGTH;
}

export function normalizeReferralCode(value: unknown) {
  return typeof value === 'string' && /^[a-z0-9]{4,16}$/.test(value.trim().toLowerCase()) ? value.trim().toLowerCase() : undefined;
}

export function hashIp(ip: string) {
  return nodeCrypto().createHash('sha256').update(`sonic-board-ip:${ip}`, 'utf8').digest('hex');
}

export function findUserByUsername(state: AccountState, username: string) {
  const key = username.toLowerCase();
  return Object.values(state.users).find((user) => user.usernameKey === key);
}

export function findUserByReferralCode(state: AccountState, code: string) {
  return Object.values(state.users).find((user) => user.referralCode === code);
}

export function toPublicAccount(user: UserRecord): PublicAccount {
  return {
    username: user.username,
    credits: user.balance,
    referralCode: user.referralCode,
    rewardedReferrals: user.rewardedReferrals,
    maxRewardedReferrals: MAX_REWARDED_REFERRALS,
  };
}

export function appendLedger(state: AccountState, entry: Omit<LedgerEntry, 'id'>, ids: Pick<IdSource, 'newId'> = defaultIds) {
  const user = state.users[entry.userId];
  if (!user) throw new Error('ledger entry for unknown user');
  if (!Number.isSafeInteger(entry.amount) || entry.amount === 0) throw new Error('ledger amount must be a non-zero integer');
  if (user.balance + entry.amount < 0) throw new Error('ledger entry would make balance negative');
  const record: LedgerEntry = { id: ids.newId(), ...entry };
  state.ledger.push(record);
  user.balance += entry.amount;
  return record;
}

export function ledgerBalance(state: AccountState, userId: string) {
  return state.ledger.reduce((sum, entry) => entry.userId === userId ? sum + entry.amount : sum, 0);
}

/** Drops expired sessions and registration records outside the IP window. */
export function pruneAccountState(state: AccountState, now: number) {
  for (const [hash, session] of Object.entries(state.sessions)) {
    if (session.expiresAt <= now || !state.users[session.userId]) delete state.sessions[hash];
  }
  state.registrations = state.registrations.filter((entry) => now - entry.at < REGISTRATION_WINDOW_MS);
}

export function registrationsFromIp(state: AccountState, ipHash: string, now: number) {
  return state.registrations.filter((entry) => entry.ipHash === ipHash && now - entry.at < REGISTRATION_WINDOW_MS).length;
}

export type RegisterInput = { username: string; passwordHash: string; ipHash: string; referralCode?: string };
export type RegisterResult =
  | { ok: true; user: UserRecord; referralApplied: boolean }
  | { ok: false; error: 'username_taken' | 'ip_limit' };

export function registerUser(state: AccountState, input: RegisterInput, now: number, ids: IdSource = defaultIds): RegisterResult {
  if (registrationsFromIp(state, input.ipHash, now) >= REGISTRATIONS_PER_IP) return { ok: false, error: 'ip_limit' };
  if (findUserByUsername(state, input.username)) return { ok: false, error: 'username_taken' };

  let referralCode = ids.newReferralCode();
  for (let attempt = 0; findUserByReferralCode(state, referralCode); attempt += 1) {
    if (attempt > 20) throw new Error('could not allocate a unique referral code');
    referralCode = ids.newReferralCode();
  }

  // A referral only counts when it points at a different, pre-existing
  // account that was not created from the same network address.
  const referrer = input.referralCode ? findUserByReferralCode(state, input.referralCode) : undefined;
  const referralApplied = Boolean(referrer && referrer.signupIpHash !== input.ipHash);

  const user: UserRecord = {
    id: ids.newId(),
    username: input.username,
    usernameKey: input.username.toLowerCase(),
    passwordHash: input.passwordHash,
    referralCode,
    referredBy: referralApplied ? referrer!.id : undefined,
    rewardedReferrals: 0,
    balance: 0,
    createdAt: now,
    signupIpHash: input.ipHash,
  };
  state.users[user.id] = user;
  state.registrations.push({ ipHash: input.ipHash, at: now });
  appendLedger(state, { userId: user.id, type: 'signup', amount: SIGNUP_CREDITS, at: now }, ids);

  if (referralApplied && referrer) {
    appendLedger(state, { userId: user.id, type: 'referral', amount: INVITEE_BONUS, at: now, ref: referrer.id, note: 'invitee_bonus' }, ids);
    if (referrer.rewardedReferrals < MAX_REWARDED_REFERRALS) {
      referrer.rewardedReferrals += 1;
      appendLedger(state, { userId: referrer.id, type: 'referral', amount: REFERRER_REWARD, at: now, ref: user.id, note: 'referrer_reward' }, ids);
    }
  }
  return { ok: true, user, referralApplied };
}

export function createSession(state: AccountState, tokenHash: string, userId: string, now: number) {
  state.sessions[tokenHash] = { userId, createdAt: now, expiresAt: now + SESSION_TTL_MS };
}

export function resolveSession(state: AccountState, tokenHash: string | undefined, now: number) {
  if (!tokenHash) return undefined;
  const session = Object.hasOwn(state.sessions, tokenHash) ? state.sessions[tokenHash] : undefined;
  if (!session || session.expiresAt <= now) return undefined;
  return state.users[session.userId];
}

export function chargeAgentUse(state: AccountState, userId: string, requestId: string, now: number, ids: Pick<IdSource, 'newId'> = defaultIds) {
  const user = state.users[userId];
  if (!user || user.balance < AGENT_REQUEST_COST) return { ok: false as const, balance: user?.balance ?? 0 };
  appendLedger(state, { userId, type: 'agent_use', amount: -AGENT_REQUEST_COST, at: now, ref: requestId }, ids);
  return { ok: true as const, balance: user.balance };
}

/** Refunds a charged request at most once. */
export function refundAgentUse(state: AccountState, userId: string, requestId: string, now: number, ids: Pick<IdSource, 'newId'> = defaultIds) {
  const charge = state.ledger.find((entry) => entry.userId === userId && entry.type === 'agent_use' && entry.ref === requestId);
  if (!charge) return false;
  if (state.ledger.some((entry) => entry.userId === userId && entry.type === 'refund' && entry.ref === requestId)) return false;
  appendLedger(state, { userId, type: 'refund', amount: -charge.amount, at: now, ref: requestId }, ids);
  return true;
}

export function grantCredits(state: AccountState, userId: string, amount: number, now: number, note?: string, ids: Pick<IdSource, 'newId'> = defaultIds) {
  return appendLedger(state, { userId, type: 'admin_grant', amount, at: now, note }, ids);
}
