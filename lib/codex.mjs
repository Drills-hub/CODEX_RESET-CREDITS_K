import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import { AppError, rpcError } from './errors.mjs';

const reads = new Set(['account/read', 'account/rateLimits/read']);
const MAC_DESKTOP_CLI_SUFFIX = ['Contents', 'Resources', 'codex-cli', 'CodexCLI.app', 'Contents', 'MacOS', 'codex'];

function macDesktopCliCandidates(env) {
  const home = typeof env.HOME === 'string' && env.HOME.trim() ? env.HOME : homedir();
  return [
    posix.join('/Applications/ChatGPT.app', ...MAC_DESKTOP_CLI_SUFFIX),
    posix.join(home, 'Applications/ChatGPT.app', ...MAC_DESKTOP_CLI_SUFFIX),
  ];
}

export function resolveCodexCommand({ env = process.env, platform = process.platform, exists = existsSync } = {}) {
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
  return 'codex';
}

export function usesShellForCodexCommand(command, platform = process.platform) {
  return platform === 'win32' && typeof command === 'string' && /\.(?:cmd|bat)$/i.test(command);
}

export class CodexClient extends EventEmitter {
  #child = null;
  #ready = null;
  #pending = new Map();
  #nextId = 1;
  constructor({ command = resolveCodexCommand(), args = ['app-server', '--listen', 'stdio://'], timeoutMs = 15000 } = {}) {
    super(); Object.assign(this, { command, args, timeoutMs });
  }
  async request(method, params = {}, deadline = Date.now() + this.timeoutMs) {
    if (!reads.has(method)) throw new AppError('FORBIDDEN');
    await this.#start(deadline);
    return this.#send(method, params, deadline);
  }
  async #start(deadline) {
    if (this.#ready) return this.#ready;
    const child = spawn(this.command, this.args, { stdio: ['pipe', 'pipe', 'pipe'], shell: usesShellForCodexCommand(this.command) });
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
      await this.#send('initialize', { clientInfo: { name: 'reset_credit_check', version: '0.1.0' } }, deadline);
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
    child.kill('SIGTERM');
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 1000); killTimer.unref();
    child.once('exit', () => clearTimeout(killTimer));
    this.emit('disconnected');
  }
  close() { if (this.#child) this.#fail(this.#child, new AppError('DISCONNECTED')); }
}
