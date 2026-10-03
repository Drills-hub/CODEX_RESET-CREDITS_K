import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { CodexClient, DISCOVERY_BUDGET_MS, resolveCodexCommand, runDiscoveryCommand, terminateProcessTree } from '../lib/codex.mjs';
import { CreditService } from '../lib/service.mjs';
import { normalizeCredits } from '../lib/credits.mjs';
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
  assert.match(s.accountScope, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(s), /SECRET/);
  assert.equal((await service.status()).authState, 'chatgpt');
});
test('malformed rate-limit response envelopes and field types are incompatible', () => {
  for (const result of [null, undefined, [], 'bad', 1, false]) {
    assert.throws(() => normalizeCredits(result), error => error.code === 'INCOMPATIBLE');
  }
  for (const summary of [[], 'bad', 1, false]) {
    assert.throws(() => normalizeCredits({ rateLimits: {}, rateLimitResetCredits: summary }), error => error.code === 'INCOMPATIBLE');
  }
  for (const availableCount of [undefined, null, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1']) {
    assert.throws(() => normalizeCredits({ rateLimits: {}, rateLimitResetCredits: { availableCount } }), error => error.code === 'INCOMPATIBLE');
  }
  for (const credits of ['', 0, {}, true]) {
    assert.throws(() => normalizeCredits({ rateLimits: {}, rateLimitResetCredits: { availableCount: 1, credits } }), error => error.code === 'INCOMPATIBLE');
  }
  for (const row of [null, [], new Date(0), Object.assign(Object.create({ inherited: true }), { title: 'bad' })]) {
    assert.throws(() => normalizeCredits({ rateLimits: {}, rateLimitResetCredits: { availableCount: 1, credits: [row] } }), error => error.code === 'INCOMPATIBLE');
  }
  assert.throws(() => normalizeCredits({ rateLimits: {}, rateLimitResetCredits: { availableCount: 10001, credits: Array(10001).fill({}) } }), error => error.code === 'INVALID_DATA');
});
test('normalization preserves unavailable, count-only, unknown timestamps/status, null expiry, and ignores extra fields', () => {
  assert.equal(normalizeCredits({ rateLimits: {} }).detailState, 'unavailable');
  assert.equal(normalizeCredits({ rateLimits: {}, rateLimitResetCredits: null }).availableCount, null);
  assert.equal(normalizeCredits({ rateLimits: {}, rateLimitResetCredits: { availableCount: 2 } }).detailState, 'count-only');
  assert.equal(normalizeCredits({ rateLimits: {}, rateLimitResetCredits: { availableCount: 1, credits: null } }).detailState, 'count-only');
  const result = normalizeCredits({ ignored: 'secret', rateLimits: {}, rateLimitResetCredits: { availableCount: 1, extra: 'ignored', credits: [{ status: 'future-status', expiresAt: null, grantedAt: 'bad', secret: 'ignored' }] } }, 1000);
  assert.deepEqual(result.credits, [{ number: 1, title: '리셋권', status: 'unknown', grantedAt: null, expiresAt: null, expiryState: 'none' }]);
  const invalidTimes = normalizeCredits({ rateLimits: {}, rateLimitResetCredits: { availableCount: 1, credits: [{ expiresAt: 'bad', grantedAt: -1 }] } });
  assert.equal(invalidTimes.credits[0].expiryState, 'unknown');
  assert.equal(invalidTimes.credits[0].grantedAt, null);
});
test('account read validates its required auth flag and optional account field', async t => {
  for (const response of [null, [], 'bad', {}, { account: null }, { requiresOpenaiAuth: 'yes', account: null }, Object.create({ requiresOpenaiAuth: true })]) {
    const client = { on() {}, request: async () => response };
    const service = new CreditService(client);
    await assert.rejects(service.status(), error => error.code === 'INCOMPATIBLE');
  }
  for (const account of [[], 'bad', 1, {}]) {
    const client = { on() {}, request: async () => ({ requiresOpenaiAuth: true, account }) };
    await assert.rejects(new CreditService(client).status(), error => error.code === 'INCOMPATIBLE');
  }
  const arrayResponse = [];
  arrayResponse.requiresOpenaiAuth = true;
  arrayResponse.account = { type: 'chatgpt' };
  await assert.rejects(new CreditService({ on() {}, request: async () => arrayResponse }).status(), error => error.code === 'INCOMPATIBLE');
  const missingOptionalAccount = { on() {}, request: async () => ({ requiresOpenaiAuth: true }) };
  assert.equal((await new CreditService(missingOptionalAccount).status()).authState, 'unsupported');
  const client = { on() {}, request: async () => ({ requiresOpenaiAuth: true, account: null }) };
  assert.equal((await new CreditService(client).status()).authState, 'signed-out');
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
test('resolves an explicit CLI path or the macOS desktop-app bundle', async () => {
  const desktopHome = posix.join('/tmp', 'reset-check-user-home');
  const desktopPath = posix.join(desktopHome, 'Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex');
  assert.equal(await resolveCodexCommand({ env: { CODEX_CLI_PATH: '/custom/codex' }, platform: 'darwin', exists: path => path === '/custom/codex' }), '/custom/codex');
  assert.equal(await resolveCodexCommand({ env: { PATH: '/custom/bin' }, platform: 'darwin', exists: path => path === '/custom/bin/codex' }), '/custom/bin/codex');
  assert.equal(await resolveCodexCommand({ env: { HOME: desktopHome }, platform: 'darwin', exists: path => path === desktopPath }), desktopPath);
  assert.equal(await resolveCodexCommand({ env: {}, platform: 'linux', exists: () => false }), 'codex');
});
test('resolves Windows command scripts through the safe wrapper path', async () => {
  const cliPath = 'C:\\custom\\bin\\codex.cmd';
  assert.equal(await resolveCodexCommand({ env: { PATH: 'C:\\custom\\bin' }, platform: 'win32', exists: path => path === cliPath }), cliPath);
});

test('discovery timeout kills a POSIX parent and grandchild process group', { skip: process.platform === 'win32' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-process-tree-'));
  const pidFile = join(directory, 'pids');
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const parentScript = "const { spawn } = require('node:child_process'); const fs = require('node:fs'); const child = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { stdio: 'ignore' }); fs.writeFileSync(process.argv[1], `${process.pid}\\n${child.pid}`); process.stdout.write('private stdout'); process.stderr.write('private stderr'); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)";
  const started = Date.now();
  const result = await runDiscoveryCommand(process.execPath, ['-e', parentScript, pidFile], { timeout: 250, platform: process.platform });
  const elapsed = Date.now() - started;
  const [parentPid, childPid] = (await readFile(pidFile, 'utf8')).split('\n').map(Number);
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const waitDead = async pid => {
    const until = Date.now() + 1000;
    while (alive(pid) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
    return alive(pid);
  };
  try {
    assert.ok(elapsed < 1500, `tree termination took ${elapsed}ms`);
    assert.equal(result.stdout, '', 'timed out command output must be discarded');
    assert.equal(result.stderr, undefined, 'stderr must not be returned');
    assert.equal(await waitDead(parentPid), false, 'parent remains alive');
    assert.equal(await waitDead(childPid), false, 'grandchild remains alive');
  } finally {
    try { process.kill(-parentPid, 'SIGKILL'); } catch {}
    try { process.kill(childPid, 'SIGKILL'); } catch {}
  }
});

test('aborting package discovery promptly terminates its active process group', { skip: process.platform === 'win32' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-abort-discovery-'));
  const pidFile = join(directory, 'pids');
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const script = "const { spawn } = require('node:child_process'); const fs = require('node:fs'); const child = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { stdio: 'ignore' }); fs.writeFileSync(process.argv[1], `${process.pid}\n${child.pid}`); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)";
  const controller = new AbortController();
  const discovery = runDiscoveryCommand(process.execPath, ['-e', script, pidFile], { timeout: 5000, signal: controller.signal, platform: process.platform });
  let pids;
  const setupDeadline = Date.now() + 1000;
  while (!pids && Date.now() < setupDeadline) {
    try { pids = (await readFile(pidFile, 'utf8')).split('\n').map(Number); } catch { await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  assert.ok(pids, 'parent and child pids should be written before abort');
  const started = Date.now();
  controller.abort();
  const result = await discovery;
  assert.equal(result.error?.name, 'AbortError');
  assert.ok(Date.now() - started < 1500, 'cancellation should stop discovery promptly');
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const waitDead = async pid => {
    const until = Date.now() + 1000;
    while (alive(pid) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
    return !alive(pid);
  };
  try {
    assert.equal(await waitDead(pids[0]), true, 'discovery parent survived cancellation');
    assert.equal(await waitDead(pids[1]), true, 'discovery grandchild survived cancellation');
  } finally {
    try { process.kill(-pids[0], 'SIGKILL'); } catch {}
    try { process.kill(pids[1], 'SIGKILL'); } catch {}
  }
});

test('resolver abort stops the remaining package-manager probes', async () => {
  const controller = new AbortController();
  const calls = [];
  await assert.rejects(resolveCodexCommand({ platform: 'linux', env: {}, signal: controller.signal, exists: () => false, runCommand: async (command, args) => {
    calls.push(command);
    controller.abort();
    return { status: null, error: Object.assign(new Error('aborted'), { name: 'AbortError', code: 'ABORT_ERR' }) };
  }}), error => error.name === 'AbortError');
  assert.deepEqual(calls, ['dpkg-query']);
});

test('Windows process-tree termination taskkills the wrapper tree before killing its root', async () => {
  const order = [];
  const wrapper = new EventEmitter();
  Object.assign(wrapper, { pid: 4321, exitCode: null, signalCode: null, kill: signal => { order.push(['wrapper-kill', signal]); wrapper.exitCode = 1; wrapper.emit('close'); } });
  const spawnCommand = (command, args) => {
    order.push([command, args]);
    const taskkill = new EventEmitter();
    queueMicrotask(() => taskkill.emit('close', 0));
    return taskkill;
  };
  await terminateProcessTree(wrapper, { platform: 'win32', spawnCommand, graceMs: 20 });
  assert.deepEqual(order[0], ['taskkill.exe', ['/PID', '4321', '/T', '/F']]);
  assert.deepEqual(order[1], ['wrapper-kill', 'SIGKILL']);
});

test('failed Windows tree and root termination unreferences live child handles', async () => {
  let childUnreferenced = false;
  let stdoutUnreferenced = false;
  const wrapper = new EventEmitter();
  Object.assign(wrapper, {
    pid: 6421,
    exitCode: null,
    signalCode: null,
    stdout: { unref() { stdoutUnreferenced = true; } },
    unref() { childUnreferenced = true; },
    kill() { throw Object.assign(new Error('permission denied'), { code: 'EPERM' }); },
  });
  await terminateProcessTree(wrapper, { platform: 'win32', spawnCommand: () => { throw new Error('taskkill missing'); }, graceMs: 20 });
  assert.equal(childUnreferenced, true);
  assert.equal(stdoutUnreferenced, true);
});

test('POSIX cleanup kills a process group after its detached leader has exited', { skip: process.platform === 'win32' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-exited-leader-'));
  const pidFile = join(directory, 'child-pid');
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const parentScript = "const { spawn } = require('node:child_process'); const fs = require('node:fs'); const child = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { stdio: 'ignore' }); child.unref(); fs.writeFileSync(process.argv[1], String(child.pid));";
  const parent = spawn(process.execPath, ['-e', parentScript, pidFile], { detached: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => { parent.once('exit', resolve); parent.once('error', reject); });
  const childPid = Number(await readFile(pidFile, 'utf8'));
  const isAlive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const waitDead = async pid => {
    const until = Date.now() + 1000;
    while (isAlive(pid) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
    return !isAlive(pid);
  };
  try {
    assert.notEqual(parent.exitCode, null, 'leader must have exited before cleanup');
    await terminateProcessTree(parent, { platform: process.platform });
    assert.equal(await waitDead(childPid), true, 'grandchild survived group cleanup');
  } finally {
    try { process.kill(-parent.pid, 'SIGKILL'); } catch {}
    try { process.kill(childPid, 'SIGKILL'); } catch {}
  }
});

test('Windows wrapper waits for delayed taskkill completion before fallback kill', async () => {
  let taskkillClosed = false;
  let taskkillKilled = false;
  let wrapperKilled = false;
  const wrapper = new EventEmitter();
  Object.assign(wrapper, {
    pid: 5321,
    exitCode: null,
    signalCode: null,
    kill() {
      wrapperKilled = true;
      this.exitCode = 1;
      this.emit('close');
    },
  });
  const spawnCommand = () => {
    const taskkill = new EventEmitter();
    Object.assign(taskkill, { exitCode: null, signalCode: null, unref() {}, kill() { taskkillKilled = true; this.signalCode = 'SIGKILL'; } });
    setTimeout(() => { taskkillClosed = true; taskkill.exitCode = 0; taskkill.emit('close', 0); }, 750);
    return taskkill;
  };
  await terminateProcessTree(wrapper, { platform: 'win32', spawnCommand });
  assert.equal(wrapperKilled, false, 'wrapper must remain alive while taskkill is still enumerating its tree');
  assert.equal(taskkillKilled, false, 'tree cleanup helper must remain alive after caller grace expires');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(taskkillClosed, true, 'detached cleanup helper should finish independently');
  assert.equal(taskkillKilled, false);
  assert.equal(wrapperKilled, true, 'wrapper should be stopped only after taskkill completes');
});

test('timed out Windows discovery unreferences stdout while detached taskkill continues', async () => {
  let child;
  let stdoutUnreferenced = false;
  let taskkillCompleted = false;
  const spawnCommand = (command, args, options) => {
    if (command !== 'taskkill.exe') {
      child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], options);
      const unref = child.stdout.unref.bind(child.stdout);
      child.stdout.unref = () => { stdoutUnreferenced = true; return unref(); };
      return child;
    }
    const taskkill = new EventEmitter();
    Object.assign(taskkill, { exitCode: null, signalCode: null, unref() {} });
    setTimeout(() => { taskkillCompleted = true; taskkill.exitCode = 0; taskkill.emit('close', 0); }, 750);
    return taskkill;
  };
  const result = await runDiscoveryCommand(process.execPath, ['-e', 'ignored'], { timeout: 100, platform: 'win32', spawnCommand });
  assert.equal(result.error?.code, 'ETIMEDOUT');
  assert.equal(stdoutUnreferenced, true);
  assert.equal(taskkillCompleted, false);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(taskkillCompleted, true);
  assert.equal(child.exitCode !== null || child.signalCode !== null, true);
});

test('explicit CLI override wins when CODEX_CLI_PATH and PATH are both set', async () => {
  const result = await resolveCodexCommand({ env: { CODEX_CLI_PATH: 'C:\\Chosen Path\\codex.exe', PATH: 'C:\\Other' }, platform: 'win32', exists: () => true, runCommand: () => assert.fail('discovery must not run') });
  assert.equal(result, 'C:\\Chosen Path\\codex.exe');
});

test('discovery timeout kills a child ignoring SIGTERM within a bounded wall time', async () => {
  const started = Date.now();
  const result = await runDiscoveryCommand(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { timeout: 150 });
  const elapsed = Date.now() - started;
  assert.equal(result.error?.code, 'ETIMEDOUT');
  assert.ok(elapsed < 1200, `expected hard bounded termination, took ${elapsed}ms`);
});

test('Windows command script probe uses an environment path and fixed quoted args', async () => {
  const cliPath = 'C:\\Users\\Me\\ChatGPT & Tools\\codex.cmd';
  const invocations = [];
  const resolved = await resolveCodexCommand({ platform: 'win32', env: {}, exists: path => path === cliPath, runCommand: (command, args, options) => {
    invocations.push({ command, args, options });
    if (args.at(-1).includes('Get-AppxPackage')) return { status: 0, stdout: 'C:\\Apps\\ChatGPT' };
    if (args.at(-1).includes('Get-ChildItem')) return { status: 0, stdout: cliPath };
    return { status: 0, stdout: 'app-server help' };
  }});
  assert.equal(resolved, cliPath);
  const invocation = invocations.at(-1);
  assert.equal(invocation.command, 'powershell.exe');
  const script = invocation.args.at(-1);
  assert.match(script, /\$env:CODEX_CLI_PATH/);
  assert.match(script, /'app-server' '--help'/);
  assert.doesNotMatch(script, /Users|ChatGPT|codex\.cmd|& Tools/);
  assert.equal(invocation.options.env.CODEX_CLI_PATH, cliPath);
});

test('CodexClient uses the same safe PowerShell wrapper for Windows command scripts', async () => {
  const cliPath = 'C:\\Apps\\ChatGPT & Tools\\codex.cmd';
  let invocation;
  const client = new CodexClient({ command: cliPath, platform: 'win32', terminateTree: async () => {}, spawnCommand: (command, args, options) => {
    invocation = { command, args, options };
    const child = {
      stdin: Object.assign(new EventEmitter(), { write: line => {
        const message = JSON.parse(line);
        if (message.id) queueMicrotask(() => child.stdout.emit('data', `${JSON.stringify({ id: message.id, result: {} })}\n`));
      }}),
      stdout: Object.assign(new EventEmitter(), { setEncoding() {} }),
      stderr: Object.assign(new EventEmitter(), { resume() {} }),
      kill() { this.emit?.('exit'); },
      on: EventEmitter.prototype.on,
      once: EventEmitter.prototype.once,
      emit: EventEmitter.prototype.emit,
    };
    Object.setPrototypeOf(child, EventEmitter.prototype);
    return child;
  }});
  try { await client.request('account/read'); } finally { client.close(); }
  assert.equal(invocation.command, 'powershell.exe');
  assert.match(invocation.args.at(-1), /\$env:CODEX_CLI_PATH/);
  assert.match(invocation.args.at(-1), /'app-server' '--listen' 'stdio:\/\/'/);
  assert.doesNotMatch(invocation.args.at(-1), /Apps|ChatGPT|codex\.cmd|& Tools/);
  assert.equal(invocation.options.env.CODEX_CLI_PATH, cliPath);
  assert.equal(invocation.options.shell, undefined);
});

test('Linux package lists preserve complete paths with spaces and reject malformed truncated lines', async () => {
  const candidate = '/opt/Chat GPT/bin/codex';
  const probes = [];
  const resolved = await resolveCodexCommand({ platform: 'linux', env: {}, exists: path => path === candidate || path === '/codex', isExecutable: () => true, runCommand: (command, args) => {
    if (command === 'dpkg-query') return { status: 0, stdout: `${candidate}\nmalformed package row /codex\n` };
    if (command === 'rpm') return { status: 0, stdout: `${candidate}\nmalformed package row /codex\n` };
    if (command === 'pacman') return { status: 0, stdout: `${candidate}\nmalformed package row /codex\n` };
    probes.push(command);
    return { status: 0, stdout: 'app-server help' };
  }});
  assert.equal(resolved, candidate);
  assert.deepEqual(probes, [candidate]);
});

test('one shared discovery deadline skips remaining package queries after expiry', async () => {
  let now = 1000;
  const calls = [];
  await resolveCodexCommand({ platform: 'linux', env: {}, now: () => now, exists: () => false, runCommand: (command, args, options) => {
    calls.push({ command, options });
    now += options.timeout;
    return { status: null, error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) };
  }});
  assert.equal(calls.length, 1);
  assert.ok(calls[0].options.timeout <= DISCOVERY_BUDGET_MS);
});

test('candidate probes share the package query deadline', async () => {
  let now = 100;
  const checked = [];
  const resolved = await resolveCodexCommand({ platform: 'linux', env: {}, now: () => now, exists: () => true, isExecutable: () => true, runCommand: (command, args, options) => {
    if (command === 'dpkg-query') return { status: 0, stdout: '/opt/chatgpt/codex\n/opt/chatgpt/second/codex\n' };
    if (command === 'rpm' || command === 'pacman') return { status: 1, stdout: '' };
    checked.push({ command, timeout: options.timeout });
    now += options.timeout;
    return { status: null, error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) };
  }});
  assert.equal(resolved, 'codex');
  assert.deepEqual(checked.map(item => item.command), ['/opt/chatgpt/codex']);
  assert.ok(checked[0].timeout <= DISCOVERY_BUDGET_MS);
});

test('explicit path and PATH take precedence without package discovery', async () => {
  let calls = 0;
  const run = () => { calls++; return { status: 0, stdout: '' }; };
  assert.equal(await resolveCodexCommand({ env: { CODEX_CLI_PATH: '/chosen/codex' }, platform: 'linux', exists: () => true, runCommand: run }), '/chosen/codex');
  assert.equal(await resolveCodexCommand({ env: { PATH: '/bin' }, platform: 'linux', exists: path => path === '/bin/codex', runCommand: run }), '/bin/codex');
  assert.equal(calls, 0);
});

test('discovers and validates a CLI within a Windows ChatGPT AppX install location', async () => {
  const calls = [];
  const result = await resolveCodexCommand({ platform: 'win32', env: {}, exists: path => path === 'C:\\Apps\\ChatGPT\\codex.exe', runCommand: (command, args, options) => {
    calls.push({ command, args, options });
    if (args.some(arg => arg.includes('Get-AppxPackage'))) return { status: 0, stdout: 'C:\\Apps\\ChatGPT' };
    if (args.some(arg => arg.includes('Get-ChildItem'))) return { status: 0, stdout: 'C:\\Apps\\ChatGPT\\codex.exe' };
    return { status: 0, stdout: args.includes('app-server') ? 'app-server help' : '' };
  }});
  assert.equal(result, 'C:\\Apps\\ChatGPT\\codex.exe');
  assert.ok(calls.some(call => call.args.some(arg => arg.includes('Get-AppxPackage'))));
  assert.ok(calls.some(call => call.args.some(arg => arg.includes('Get-ChildItem'))));
  assert.ok(calls.some(call => call.args.includes('app-server')));
  assert.ok(calls.every(call => call.options.timeout > 0));
});

test('discovers Linux package-owned CLI candidates and validates app-server support', async () => {
  for (const [manager, command, listing] of [
    ['debian', 'dpkg-query', '/usr/lib/chatgpt/resources/codex\n'],
    ['rpm', 'rpm', '/opt/chatgpt/bin/codex\n'],
    ['pacman', 'pacman', '/opt/chatgpt/bin/codex\n'],
  ]) {
    const candidate = listing.match(/(?:^|\s)(\/[^\s]+codex)\s*$/m)?.[1] ?? '/usr/lib/chatgpt/resources/codex';
    const calls = [];
    const resolved = await resolveCodexCommand({ platform: 'linux', env: {}, exists: path => path === candidate, isExecutable: () => true, runCommand: (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'dpkg-query' || cmd === 'rpm' || cmd === 'pacman') return { status: cmd === command ? 0 : 1, stdout: cmd === command ? listing : '' };
      return { status: 0, stdout: args.includes('app-server') ? 'app-server help' : '' };
    }});
    assert.equal(resolved, candidate, `${manager} package candidate`);
    assert.ok(calls.some(([cmd, args]) => cmd === command && args.includes('chatgpt')));
    if (command === 'pacman') assert.ok(calls.some(([cmd, args]) => cmd === 'pacman' && args[0] === '-Qlq'));
    assert.ok(calls.some(([, args]) => args.includes('app-server')));
  }
});

test('skips non-executable or unsupported candidates and falls back to codex', async () => {
  const candidates = ['/opt/chatgpt/codex', '/opt/chatgpt/other/codex'];
  let validation = 0;
  const resolved = await resolveCodexCommand({ platform: 'linux', env: {}, exists: path => candidates.includes(path), isExecutable: path => path !== candidates[0], runCommand: (command, args) => {
    if (command === 'dpkg-query') return { status: 0, stdout: candidates.join('\n') };
    if (args.includes('app-server')) { validation++; return { status: 1, stdout: '' }; }
    return { status: 1, stdout: '' };
  }});
  assert.equal(resolved, 'codex');
  assert.equal(validation, 1);
});

test('empty package discovery and command timeouts fall back without exposing output', async () => {
  for (const runCommand of [
    () => ({ status: 0, stdout: '' }),
    () => ({ status: null, error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }), stdout: 'sensitive' }),
  ]) {
    assert.equal(await resolveCodexCommand({ platform: 'linux', env: {}, exists: () => false, runCommand }), 'codex');
  }
});
