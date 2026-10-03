import { createHash } from 'node:crypto';
import { normalizeCredits } from './credits.mjs';
import { AppError } from './errors.mjs';
export class CreditService {
  #identity;
  #busy = false;
  #auth = 'unknown';
  #revision = 0;
  #connected = false;
  constructor(client, { timeoutMs = 15000 } = {}) {
    this.client = client; this.timeoutMs = timeoutMs;
    client.on('accountChanged', ({ signedOut }) => {
      this.#revision++; this.#identity = undefined;
      this.#auth = signedOut ? 'signed-out' : 'unknown';
    });
    client.on('disconnected', () => { this.#connected = false; });
  }
  async #account(deadline) {
    const result = await this.client.request('account/read', { refreshToken: false }, deadline);
    if (!result || typeof result !== 'object' || Array.isArray(result) || !Object.hasOwn(result, 'requiresOpenaiAuth') || typeof result.requiresOpenaiAuth !== 'boolean') throw new AppError('INCOMPATIBLE');
    const hasAccount = Object.hasOwn(result, 'account');
    const account = hasAccount ? result.account : undefined;
    if (hasAccount && account !== null && (!account || typeof account !== 'object' || Array.isArray(account) || typeof account.type !== 'string')) throw new AppError('INCOMPATIBLE');
    const auth = account === null ? 'signed-out' : account?.type === 'chatgpt' ? 'chatgpt' : 'unsupported';
    // Private fingerprint detects confirmed account switches. It is never returned.
    const identity = createHash('sha256').update(JSON.stringify({ hasAccount, account: account ?? null })).digest('hex');
    if (this.#identity !== undefined && this.#identity !== identity) this.#revision++;
    this.#identity = identity; this.#auth = auth; this.#connected = true;
    return auth;
  }
  async status({ refresh = true } = {}) {
    if (refresh && !this.#busy) await this.#account(Date.now() + this.timeoutMs);
    return { connected: this.#connected, authState: this.#auth, revision: this.#revision, busy: this.#busy };
  }
  async read() {
    if (this.#busy) throw new AppError('BUSY');
    this.#busy = true;
    const deadline = Date.now() + this.timeoutMs;
    const previousRevision = this.#revision;
    try {
      const auth = await this.#account(deadline);
      if (auth !== 'chatgpt') throw new AppError(auth === 'signed-out' ? 'LOGIN_REQUIRED' : 'AUTH_UNSUPPORTED');
      const revision = this.#revision;
      const result = await this.client.request('account/rateLimits/read', {}, deadline);
      await this.#account(deadline);
      if (revision !== this.#revision || this.#auth !== 'chatgpt') throw new AppError('ACCOUNT_CHANGED');
      return { ...normalizeCredits(result), revision: this.#revision };
    } catch (error) {
      if (error.code === 'LOGIN_REQUIRED') { this.#auth = 'signed-out'; this.#revision++; }
      if (this.#revision !== previousRevision && !['LOGIN_REQUIRED', 'AUTH_UNSUPPORTED'].includes(error.code)) throw new AppError('ACCOUNT_CHANGED');
      throw error;
    } finally { this.#busy = false; }
  }
}
