// A subprocess fixture exercises real JSONL framing/lifecycle, without an external account.
import readline from 'node:readline';
import { existsSync, writeFileSync } from 'node:fs';
const mode = process.argv[2] ?? 'normal';
const send = msg => process.stdout.write(JSON.stringify(msg) + '\n');
let initialized = false;
let accountReads = 0;
let usageReads = 0;
for await (const line of readline.createInterface({ input: process.stdin })) {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    if (mode === 'initialize-once-fails' && !existsSync(process.argv[3])) {
      writeFileSync(process.argv[3], 'attempted');
      send({ id: msg.id, error: { code: -32000, message: 'SECRET_TOKEN transient error' } });
      continue;
    }
    if (mode === 'timeout') continue;
    if (mode === 'disconnect') process.exit(0);
    send({ id: msg.id, result: { userAgent: 'fixture' } });
  } else if (msg.method === 'initialized') initialized = true;
  else if (!initialized) send({ id: msg.id, error: { code: -32600, message: 'Not initialized' } });
  else if (msg.method === 'account/read') {
    accountReads++;
    send({ id: msg.id, result: { requiresOpenaiAuth: true, account: mode === 'logged-out' ? null : { type: mode === 'api-key' ? 'apiKey' : 'chatgpt', email: mode === 'switch-then-timeout' && accountReads >= 3 ? 'SECRET_OTHER_EMAIL' : 'SECRET_EMAIL', accountId: 'SECRET_ACCOUNT' } } });
  }
  else if (msg.method === 'account/rateLimits/read') {
    usageReads++;
    if (mode === 'switch-then-timeout' && usageReads >= 2) continue;
    if (mode === 'rpc-error') send({ id: msg.id, error: { code: -32601, message: 'SECRET_TOKEN unsupported' } });
    else if (mode === 'unauthorized') send({ id: msg.id, error: { code: 401, message: 'SECRET_TOKEN Unauthorized' } });
    else if (mode === 'rate-timeout') continue;
    else if (mode === 'account-change') {
      send({ method: 'account/updated', params: { authMode: null } });
      send({ id: msg.id, result: { rateLimits: {}, rateLimitResetCredits: { availableCount: 1, credits: [] } } });
    } else send({ id: msg.id, result: { rateLimits: {}, rateLimitResetCredits: { availableCount: 1, credits: [{ id: 'SECRET_CREDIT', status: 'available', grantedAt: 0, expiresAt: 1784246400, title: 'Full reset' }] } } });
  } else send({ id: msg.id, error: { code: -32601, message: 'Forbidden method' } });
}
