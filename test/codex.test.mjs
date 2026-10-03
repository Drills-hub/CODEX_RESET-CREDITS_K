import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { CodexClient, resolveCodexCommand, usesShellForCodexCommand } from '../lib/codex.mjs';
import { CreditService } from '../lib/service.mjs';
const fixture = fileURLToPath(new URL('./fixtures/codex.mjs', import.meta.url));
function make(t, mode = 'normal', timeoutMs = 1000) {
  const client = new CodexClient({ command: process.execPath, args: [fixture, mode], timeoutMs });
  t.after(() => client.close());
  return { client, service: new CreditService(client, { timeoutMs }) };
}
test('real stdio handshake queries credits without returning account identity', async t => {
  const { service } = make(t);
  const s = await service.read();
  assert.equal(s.availableCount, 1);
  assert.equal(s.credits[0].expiresAt, 1784246400);
  assert.doesNotMatch(JSON.stringify(s), /SECRET/);
  assert.equal((await service.status()).authState, 'chatgpt');
});
for (const [mode, code] of [['logged-out', 'LOGIN_REQUIRED'], ['api-key', 'AUTH_UNSUPPORTED'], ['rpc-error', 'INCOMPATIBLE'], ['unauthorized', 'LOGIN_REQUIRED'], ['timeout', 'TIMEOUT'], ['disconnect', 'DISCONNECTED'], ['rate-timeout', 'TIMEOUT'], ['account-change', 'ACCOUNT_CHANGED']]) {
  test(`sanitizes ${mode} failures`, async t => {
    const { service } = make(t, mode, 150);
    await assert.rejects(service.read(), error => error.code === code && !error.message.includes('SECRET'));
  });
}
test('arbitrary RPC and mutation methods cannot be sent', async t => {
  const { client } = make(t);
  for (const method of ['account/rateLimitResetCredit/consume', 'turn/start', 'account/sendAddCreditsNudgeEmail']) {
    await assert.rejects(client.request(method), error => error.code === 'FORBIDDEN');
  }
});
test('concurrent refresh is rejected', async t => {
  const { service } = make(t, 'rate-timeout', 200);
  const first = service.read();
  await assert.rejects(service.read(), error => error.code === 'BUSY');
  await assert.rejects(first, error => error.code === 'TIMEOUT');
});
test('account switch followed by a failed refresh invalidates previous account data', async t => {
  const { service } = make(t, 'switch-then-timeout', 200);
  await service.read();
  await assert.rejects(service.read(), error => error.code === 'ACCOUNT_CHANGED');
});
test('a failed initialize does not poison subsequent manual refreshes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'reset-check-initialize-'));
  const client = new CodexClient({ command: process.execPath, args: [fixture, 'initialize-once-fails', join(directory, 'attempt')], timeoutMs: 1000 });
  t.after(async () => { client.close(); await rm(directory, { recursive: true, force: true }); });
  const service = new CreditService(client);
  await assert.rejects(service.read(), error => error.code === 'UPSTREAM');
  assert.equal((await service.read()).availableCount, 1);
});
test('resolves an explicit CLI path or the macOS desktop-app bundle', () => {
  const desktopHome = posix.join('/tmp', 'reset-check-user-home');
  const desktopPath = posix.join(desktopHome, 'Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex');
  assert.equal(resolveCodexCommand({ env: { CODEX_CLI_PATH: '/custom/codex' }, platform: 'darwin', exists: path => path === '/custom/codex' }), '/custom/codex');
  assert.equal(resolveCodexCommand({ env: { PATH: '/custom/bin' }, platform: 'darwin', exists: path => path === '/custom/bin/codex' }), '/custom/bin/codex');
  assert.equal(resolveCodexCommand({ env: { HOME: desktopHome }, platform: 'darwin', exists: path => path === desktopPath }), desktopPath);
  assert.equal(resolveCodexCommand({ env: {}, platform: 'linux', exists: () => false }), 'codex');
});
test('resolves Windows command scripts and enables shell execution for them', () => {
  const cliPath = 'C:\\custom\\bin\\codex.cmd';
  assert.equal(resolveCodexCommand({ env: { PATH: 'C:\\custom\\bin' }, platform: 'win32', exists: path => path === cliPath }), cliPath);
  assert.equal(usesShellForCodexCommand(cliPath, 'win32'), true);
  assert.equal(usesShellForCodexCommand('C:\\custom\\bin\\codex.exe', 'win32'), false);
  assert.equal(usesShellForCodexCommand('/custom/bin/codex', 'darwin'), false);
});
