import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import { performance } from 'node:perf_hooks';
import { AppError, rpcError } from './errors.mjs';
import pkg from '../package.json' with { type: 'json' };

const reads = new Set(['account/read', 'account/rateLimits/read']);
const MAC_DESKTOP_CLI_SUFFIX = ['Contents', 'Resources', 'codex-cli', 'CodexCLI.app', 'Contents', 'MacOS', 'codex'];
export const DISCOVERY_BUDGET_MS = 3000;
const MAX_PACKAGE_CANDIDATES = 20;

const abortError = () => Object.assign(new Error('Discovery aborted'), { name: 'AbortError', code: 'ABORT_ERR' });

function waitForClose(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    const timer = setTimeout(() => { child.removeListener('close', onClose); resolve(false); }, timeoutMs);
    const onClose = () => { clearTimeout(timer); resolve(true); };
    child.once('close', onClose);
  });
}

function waitForTaskkill(taskkill, timeoutMs) {
  return new Promise(resolve => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      taskkill.removeListener('close', done);
      taskkill.removeListener('error', done);
      resolve(true);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      taskkill.removeListener('close', done);
      taskkill.removeListener('error', done);
      resolve(false);
    }, timeoutMs);
    taskkill.once('close', done);
    taskkill.once('error', done);
  });
}

function unrefChildHandles(child) {
  child.stdin?.unref?.();
  child.stdout?.unref?.();
  child.stderr?.unref?.();
  child.unref?.();
}

async function killWindowsRoot(child, graceMs) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { child.kill('SIGKILL'); } catch {}
  if (!await waitForClose(child, graceMs)) unrefChildHandles(child);
}

export async function terminateProcessTree(child, { platform = process.platform, spawnCommand = spawn, graceMs = 500 } = {}) {
  if (!child) return;
  if (platform === 'win32' && child.pid) {
    let taskkill;
    try {
      taskkill = spawnCommand('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, detached: true });
      taskkill.unref?.();
    } catch {}
    if (taskkill) {
      const completed = await waitForTaskkill(taskkill, graceMs);
      if (!completed) {
        unrefChildHandles(child);
        const stopRoot = () => { void killWindowsRoot(child, graceMs); };
        taskkill.once('close', stopRoot);
        taskkill.once('error', stopRoot);
        return;
      }
      await killWindowsRoot(child, graceMs);
    } else {
      await killWindowsRoot(child, graceMs);
    }
    return;
  }
  if (platform !== 'win32' && child.pid) {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch {
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGKILL'); } catch { unrefChildHandles(child); }
      }
    }
  } else if (child.exitCode === null && child.signalCode === null) {
    try { child.kill('SIGKILL'); } catch { unrefChildHandles(child); }
  }
  if (!await waitForClose(child, graceMs)) unrefChildHandles(child);
}

export function runDiscoveryCommand(command, args, { timeout, platform = process.platform, spawnCommand = spawn, terminateTree = terminateProcessTree, signal, ...options } = {}) {
  return new Promise(resolve => {
    let child;
    let stdout = '';
    let stopping = false;
    let settled = false;
    let timer;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const stop = error => {
      if (stopping || settled) return;
      stopping = true;
      stdout = '';
      clearTimeout(timer);
      child.stdin?.unref?.();
      child.stdout?.unref?.();
      child.stderr?.unref?.();
      Promise.resolve(terminateTree(child, { platform, spawnCommand }))
        .catch(() => {})
        .finally(() => finish({ status: null, error, stdout: '' }));
    };
    const onAbort = () => stop(abortError());
    if (signal?.aborted) { finish({ status: null, error: abortError(), stdout: '' }); return; }
    try {
      child = spawnCommand(command, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, detached: platform !== 'win32', ...options });
    } catch (error) {
      finish({ status: null, error, stdout: '' });
      return;
    }
    child.stdout?.setEncoding?.('utf8');
    child.stdout?.on('data', chunk => {
      if (stopping || settled) return;
      stdout += chunk;
      if (stdout.length > 1024 * 1024) stdout = stdout.slice(0, 1024 * 1024);
    });
    child.on('error', error => {
      if (stopping) return;
      finish({ status: null, error, stdout: '' });
    });
    child.on('close', (status, signal) => {
      if (!stopping) finish({ status, signal, stdout });
    });
    timer = setTimeout(() => stop(Object.assign(new Error('Process timed out'), { code: 'ETIMEDOUT' })), Math.max(1, timeout ?? DISCOVERY_BUDGET_MS));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

async function runText(runCommand, command, args, deadline, now, options = {}) {
  const timeout = Math.floor(deadline - now());
  if (timeout <= 0) return '';
  try {
    const result = await runCommand(command, args, { timeout, ...options });
    if (options.signal?.aborted || result?.error?.name === 'AbortError') throw result?.error ?? abortError();
    return result?.status === 0 && !result.error ? String(result.stdout ?? '') : '';
  } catch (error) {
    if (options.signal?.aborted || error?.name === 'AbortError') throw error;
    return '';
  }
}

function powershellInvocation(command, args) {
  const quote = value => `'${String(value).replaceAll("'", "''")}'`;
  return {
    command: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `& $env:CODEX_CLI_PATH ${args.map(quote).join(' ')}`],
    env: { ...process.env, CODEX_CLI_PATH: command },
  };
}

function discoveryInvocation(command, args, platform) {
  return platform === 'win32' && typeof command === 'string' && /\.(?:cmd|bat)$/i.test(command) ? powershellInvocation(command, args) : { command, args };
}

async function supportsAppServer(candidate, platform, runCommand, deadline, now, signal) {
  const invocation = discoveryInvocation(candidate, ['app-server', '--help'], platform);
  const output = await runText(runCommand, invocation.command, invocation.args, deadline, now, { env: invocation.env, signal });
  return /app-server/i.test(output);
}

async function windowsPackageCandidates(runCommand, deadline, now, signal) {
  const shell = 'powershell.exe';
  const commonArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];
  const locations = (await runText(runCommand, shell, [...commonArgs, "Get-AppxPackage | Where-Object { $_.Name -like '*ChatGPT*' -or $_.PackageFamilyName -like '*ChatGPT*' } | Select-Object -ExpandProperty InstallLocation"], deadline, now, { signal })).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const candidates = [];
  for (const location of locations.slice(0, 10)) {
    if (signal?.aborted) throw abortError();
    const escaped = location.replaceAll("'", "''");
    const found = await runText(runCommand, shell, [...commonArgs, `$root='${escaped}'; Get-ChildItem -LiteralPath $root -File -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.Name -in @('codex.exe','codex.cmd','codex.bat') } | Select-Object -First ${MAX_PACKAGE_CANDIDATES} -ExpandProperty FullName`], deadline, now, { signal });
    candidates.push(...found.split(/\r?\n/).map(line => line.trim()).filter(Boolean));
    if (candidates.length >= MAX_PACKAGE_CANDIDATES) break;
  }
  return candidates.slice(0, MAX_PACKAGE_CANDIDATES);
}

async function linuxPackageCandidates(runCommand, deadline, now, signal) {
  const outputs = [];
  outputs.push(await runText(runCommand, 'dpkg-query', ['-L', 'chatgpt'], deadline, now, { signal }));
  outputs.push(await runText(runCommand, 'rpm', ['-ql', 'chatgpt'], deadline, now, { signal }));
  outputs.push(await runText(runCommand, 'pacman', ['-Qlq', 'chatgpt'], deadline, now, { signal }));
  return [...new Set(outputs.flatMap(output => output.split(/\r?\n/)).filter(path => path.startsWith('/') && path.split('/').at(-1) === 'codex'))].slice(0, MAX_PACKAGE_CANDIDATES);
}

function macDesktopCliCandidates(env) {
  const home = typeof env.HOME === 'string' && env.HOME.trim() ? env.HOME : homedir();
  return [
    posix.join('/Applications/ChatGPT.app', ...MAC_DESKTOP_CLI_SUFFIX),
    posix.join(home, 'Applications/ChatGPT.app', ...MAC_DESKTOP_CLI_SUFFIX),
  ];
}

export async function resolveCodexCommand({ env = process.env, platform = process.platform, exists = existsSync, isExecutable = path => { try { return statSync(path).isFile() && (platform === 'win32' || (accessSync(path, constants.X_OK), true)); } catch { return false; } }, runCommand = runDiscoveryCommand, now = () => performance.now(), signal } = {}) {
  if (signal?.aborted) throw abortError();
  const override = typeof env.CODEX_CLI_PATH === 'string' ? env.CODEX_CLI_PATH.trim() : '';
  if (override) return override;
  const pathImpl = platform === 'win32' ? win32 : posix;
  const executables = platform === 'win32' ? ['codex.exe', 'codex.cmd', 'codex.bat', 'codex'] : ['codex'];
  const pathCandidate = String(env.PATH ?? '').split(pathImpl.delimiter).filter(Boolean)
    .flatMap(dir => executables.map(executable => pathImpl.join(dir, executable))).find(exists);
  if (pathCandidate) return pathCandidate;
  if (platform === 'darwin') {
    const desktopPath = macDesktopCliCandidates(env).find(exists);
    if (desktopPath) return desktopPath;
  }
  if (platform !== 'win32' && platform !== 'linux') return 'codex';
  const deadline = now() + DISCOVERY_BUDGET_MS;
  const candidates = platform === 'win32' ? await windowsPackageCandidates(runCommand, deadline, now, signal) : await linuxPackageCandidates(runCommand, deadline, now, signal);
  for (const candidate of candidates) {
    if (signal?.aborted) throw abortError();
    if (now() >= deadline) break;
    if (!exists(candidate)) continue;
    if (platform !== 'win32' && !isExecutable(candidate)) continue;
    if (await supportsAppServer(candidate, platform, runCommand, deadline, now, signal)) return candidate;
  }
  return 'codex';
}

export class CodexClient extends EventEmitter {
  #child = null;
  #ready = null;
  #pending = new Map();
  #nextId = 1;
  constructor({ command = 'codex', args = ['app-server', '--listen', 'stdio://'], timeoutMs = 15000, platform = process.platform, spawnCommand = spawn, terminateTree = terminateProcessTree } = {}) {
    super(); Object.assign(this, { command, args, timeoutMs, platform, spawnCommand, terminateTree });
  }
  async request(method, params = {}, deadline = Date.now() + this.timeoutMs) {
    if (!reads.has(method)) throw new AppError('FORBIDDEN');
    await this.#start(deadline);
    return this.#send(method, params, deadline);
  }
  async #start(deadline) {
    if (this.#ready) return this.#ready;
    const invocation = discoveryInvocation(this.command, this.args, this.platform);
    const child = this.spawnCommand(invocation.command, invocation.args, { stdio: ['pipe', 'pipe', 'pipe'], ...(invocation.env ? { env: invocation.env } : {}) });
    this.#child = child;
    // Drain, but never log raw stderr: it may contain identities or upstream errors.
    child.stderr.resume();
    child.stdin.on('error', () => this.#fail(child, new AppError('DISCONNECTED')));
    child.on('error', error => this.#fail(child, new AppError(error.code === 'ENOENT' ? 'CLI_MISSING' : 'DISCONNECTED')));
    child.on('exit', () => this.#fail(child, new AppError('DISCONNECTED')));
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (this.#child !== child) return;
      buffer += chunk;
      if (buffer.length > 2 * 1024 * 1024) { this.#fail(child, new AppError('INVALID_DATA')); return; }
      let split;
      while ((split = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, split); buffer = buffer.slice(split + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { this.#fail(child, new AppError('INCOMPATIBLE')); return; }
        if (!msg || typeof msg !== 'object') { this.#fail(child, new AppError('INCOMPATIBLE')); return; }
        const pending = this.#pending.get(msg.id);
        if (pending) {
          this.#pending.delete(msg.id); clearTimeout(pending.timer);
          if (msg.error) pending.reject(rpcError(msg.error)); else pending.resolve(msg.result);
        } else if (msg.method === 'account/updated') {
          // Only the auth state reaches listeners; never pass an original notification.
          this.emit('accountChanged', { signedOut: msg.params?.authMode === null });
        }
      }
    });
    this.#ready = (async () => {
      await this.#send('initialize', { clientInfo: { name: 'reset_credit_check', version: pkg.version } }, deadline);
      if (this.#child !== child) throw new AppError('DISCONNECTED');
      child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
    })().catch(error => {
      this.#fail(child, error);
      throw error;
    });
    return this.#ready;
  }
  #send(method, params, deadline) {
    if (!this.#child || deadline <= Date.now()) return Promise.reject(new AppError(deadline <= Date.now() ? 'TIMEOUT' : 'DISCONNECTED'));
    const child = this.#child;
    return new Promise((resolve, reject) => {
      const id = this.#nextId++;
      const timer = setTimeout(() => {
        this.#pending.delete(id); reject(new AppError('TIMEOUT'));
        this.#fail(child, new AppError('DISCONNECTED'));
      }, deadline - Date.now());
      this.#pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  #fail(child, error) {
    if (this.#child !== child) return;
    this.#child = null; this.#ready = null;
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.#pending.clear();
    const wrapped = this.platform === 'win32' && /\.(?:cmd|bat)$/i.test(this.command);
    if (wrapped && child.pid) {
      child.stdin?.unref?.();
      child.stdout?.unref?.();
      child.stderr?.unref?.();
      void this.terminateTree(child, { platform: 'win32', spawnCommand: this.spawnCommand });
    } else if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 1000); killTimer.unref();
      child.once('exit', () => clearTimeout(killTimer));
    }
    this.emit('disconnected');
  }
  close() { if (this.#child) this.#fail(this.#child, new AppError('DISCONNECTED')); }
}
