import {
  chargeAgentUse,
  createSession,
  findUserByUsername,
  hashIp,
  isValidPassword,
  normalizeReferralCode,
  normalizeUsername,
  refundAgentUse,
  registerUser,
  resolveSession,
  toPublicAccount,
  type PublicAccount,
} from './accounts.ts';
import { hashPassword, verifyAgainstDummy, verifyPassword } from './password.ts';
import { ConcurrencyGate, SlidingWindowLimiter } from './rate-limit.ts';
import { createSessionToken, hashSessionToken } from './session.ts';
import { JsonAccountStore, type AccountStore } from './store.ts';

export const AUTH_ATTEMPTS_PER_MINUTE = 10;
export const AGENT_REQUESTS_PER_MINUTE = 5;
export const AGENT_MAX_IN_FLIGHT = 4;

export type AuthFailure = { ok: false; status: number; error: string };
export type AuthSuccess = { ok: true; token: string; account: PublicAccount };

const tooManyAttempts: AuthFailure = { ok: false, status: 429, error: '尝试过于频繁，请稍后再试。' };
const badCredentials: AuthFailure = { ok: false, status: 401, error: '用户名或密码错误。' };

export class AccountService {
  readonly store: AccountStore;
  readonly authLimiter = new SlidingWindowLimiter(AUTH_ATTEMPTS_PER_MINUTE, 60_000);
  readonly agentLimiter = new SlidingWindowLimiter(AGENT_REQUESTS_PER_MINUTE, 60_000);
  readonly agentGate = new ConcurrencyGate(AGENT_MAX_IN_FLIGHT);

  constructor(store: AccountStore) {
    this.store = store;
  }

  async register(input: { username: unknown; password: unknown; referralCode?: unknown; ip: string }): Promise<AuthSuccess | AuthFailure> {
    if (!this.authLimiter.tryHit(input.ip)) return tooManyAttempts;
    const username = normalizeUsername(input.username);
    if (!username) return { ok: false, status: 400, error: '用户名需为 3–24 位字母、数字、下划线或连字符。' };
    if (!isValidPassword(input.password)) return { ok: false, status: 400, error: '密码需为 8–128 位。' };
    const passwordHash = await hashPassword(input.password);
    const token = createSessionToken();
    const ipHash = hashIp(input.ip);
    const referralCode = normalizeReferralCode(input.referralCode);
    const result = await this.store.transact((state, now) => {
      const registered = registerUser(state, { username, passwordHash, ipHash, referralCode }, now);
      if (!registered.ok) return registered;
      createSession(state, hashSessionToken(token), registered.user.id, now);
      return { ok: true as const, account: toPublicAccount(registered.user) };
    });
    if (!result.ok) {
      return result.error === 'username_taken'
        ? { ok: false, status: 409, error: '该用户名已被注册。' }
        : { ok: false, status: 429, error: '当前网络今天注册的账号过多，请明天再试。' };
    }
    return { ok: true, token, account: result.account };
  }

  async login(input: { username: unknown; password: unknown; ip: string }): Promise<AuthSuccess | AuthFailure> {
    if (!this.authLimiter.tryHit(input.ip)) return tooManyAttempts;
    const username = normalizeUsername(input.username);
    const password = typeof input.password === 'string' && input.password.length <= 1024 ? input.password : '';
    const user = username ? await this.store.read((state) => findUserByUsername(state, username)) : undefined;
    if (!user) {
      await verifyAgainstDummy(password);
      return badCredentials;
    }
    if (!(await verifyPassword(password, user.passwordHash))) return badCredentials;
    const token = createSessionToken();
    const account = await this.store.transact((state, now) => {
      const current = state.users[user.id];
      if (!current) return undefined;
      createSession(state, hashSessionToken(token), current.id, now);
      return toPublicAccount(current);
    });
    return account ? { ok: true, token, account } : badCredentials;
  }

  async logout(token: string | undefined) {
    if (!token) return;
    const hash = hashSessionToken(token);
    await this.store.transact((state) => {
      delete state.sessions[hash];
    });
  }

  /** Resolves a session cookie to its user, or undefined when missing/expired. */
  async authenticate(token: string | undefined) {
    if (!token) return undefined;
    const hash = hashSessionToken(token);
    const now = Date.now();
    return this.store.read((state) => {
      const user = resolveSession(state, hash, now);
      return user ? { id: user.id, account: toPublicAccount(user) } : undefined;
    });
  }

  chargeAgentUse(userId: string, requestId: string) {
    return this.store.transact((state, now) => chargeAgentUse(state, userId, requestId, now));
  }

  refundAgentUse(userId: string, requestId: string) {
    return this.store.transact((state, now) => refundAgentUse(state, userId, requestId, now));
  }
}

// Cached on globalThis so every bundled copy of this module shares one set of
// limiters and one store mutex inside the server process.
export function getAccountService(): AccountService {
  const holder = globalThis as typeof globalThis & { __sonicBoardAccountService?: AccountService };
  holder.__sonicBoardAccountService ??= new AccountService(new JsonAccountStore());
  return holder.__sonicBoardAccountService;
}
